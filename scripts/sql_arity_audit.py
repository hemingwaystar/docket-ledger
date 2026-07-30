#!/usr/bin/env python3
"""sql_arity_audit — pre-ship battery member (born of bug #33).

Statically audits every `cur.execute(<literal SQL>, (<literal tuple>))` in the
services for two mismatch classes psycopg only reports at runtime:

  1. %s placeholder count vs. the length of a literal params tuple/list.
     (psycopg3 raises this CLIENT-SIDE, which leaves the transaction alive —
     so work executed before the bad statement can still COMMIT: bug #33's
     ghost-ticket mechanism.)
  2. For INSERT ... (cols) VALUES (exprs): column count vs. top-level
     expression count — the server-side twin of the same slip.

Dynamic SQL / non-literal params are skipped (reported with --verbose).
Exit 1 on any finding, so it can gate a bundle like py_compile does.
"""
import ast
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "services"
PLACEHOLDER = re.compile(r"%s")
INSERT = re.compile(
    r"INSERT\s+INTO\s+\S+\s*\((?P<cols>[^)]*)\)\s*VALUES\s*\(", re.I | re.S)


def top_level_split(text: str) -> list[str]:
    """Split on commas at paren depth zero, ignoring commas inside SQL
    single-quoted strings ('' is the escape)."""
    depth, items, cur, in_str = 0, [], "", False
    for ch in text:
        if ch == "'":
            in_str = not in_str          # '' toggles twice — net unchanged
        elif not in_str:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth == 0:
                items.append(cur.strip())
                cur = ""
                continue
        cur += ch
    if cur.strip():
        items.append(cur.strip())
    return items


def values_exprs(sql: str) -> tuple[int, int] | None:
    """(n_columns, n_expressions) for a literal INSERT, else None."""
    m = INSERT.search(sql)
    if not m:
        return None
    cols = [c for c in m.group("cols").split(",") if c.strip()]
    rest = sql[m.end():]
    depth, buf, in_str = 1, "", False
    for ch in rest:
        if ch == "'":
            in_str = not in_str
        elif not in_str:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    break
        buf += ch
    else:
        return None                      # unbalanced — dynamic, skip
    return len(cols), len(top_level_split(buf))


def literal_sql(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def literal_len(node: ast.AST) -> int | None:
    if isinstance(node, (ast.Tuple, ast.List)):
        if any(isinstance(e, ast.Starred) for e in node.elts):
            return None
        return len(node.elts)
    return None


def audit(path: pathlib.Path, verbose: bool) -> list[str]:
    findings = []
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "execute"):
            continue
        if not node.args:
            continue
        sql = literal_sql(node.args[0])
        where = f"{path.relative_to(ROOT.parent)}:{node.lineno}"
        if sql is None:
            if verbose:
                print(f"  (skip dynamic SQL) {where}")
            continue
        n_ph = len(PLACEHOLDER.findall(sql))
        if len(node.args) > 1:
            n_params = literal_len(node.args[1])
            if n_params is None and verbose:
                print(f"  (skip dynamic params) {where}")
            if n_params is not None and n_params != n_ph:
                findings.append(
                    f"{where}: {n_ph} %s placeholder(s) but {n_params} "
                    f"literal param(s)")
        elif n_ph:
            findings.append(
                f"{where}: {n_ph} %s placeholder(s) but no params argument")
        ins = values_exprs(sql)
        if ins and ins[0] != ins[1]:
            findings.append(
                f"{where}: INSERT lists {ins[0]} column(s) but VALUES has "
                f"{ins[1]} expression(s)")
    return findings


def main() -> int:
    verbose = "--verbose" in sys.argv
    findings = []
    for path in sorted(ROOT.rglob("*.py")):
        findings += audit(path, verbose)
    if findings:
        print("SQL ARITY AUDIT — FAIL")
        for f in findings:
            print("  " + f)
        return 1
    print("SQL ARITY AUDIT — clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
