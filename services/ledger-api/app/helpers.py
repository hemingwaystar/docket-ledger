"""Shared by the ledger routers: the bug-#27 span guard, the entry
visibility scope (audit: read-side RBAC enforced server-side), and the Odoo
draft-invoice payload builder (export preview and mark-exported price
from the same function by construction)."""
from fastapi import HTTPException


def entry_scope_where(who: dict, alias: str = "e"):
    """Server-side mirror of the UI's entry visibility: the money-side roles
    (l_approve / l_export) see EVERYTHING — their Approvals/Periods views
    compute from the unscoped entry set, gated only by the nav perm — while
    everyone else gets scopedEntries() semantics: l_view_all → every tech;
    else l_view_own → own rows only; neither → nothing; client access modes
    (0017: all/restricted/group) on top unless l_all_clients. Returns
    (sql, args) to AND into a WHERE. PATs are all-scope service credentials,
    like need()."""
    if who["kind"] != "session":
        return "TRUE", []
    if who["perms"] & {"l_approve", "l_export"}:
        return "TRUE", []
    args = []
    if "l_view_all" in who["perms"]:
        tech_sql = "TRUE"
    elif "l_view_own" in who["perms"]:
        tech_sql = f"{alias}.tech_id = %s"
        args.append(who["agent_id"])
    else:
        return "FALSE", []
    parts = [tech_sql]
    if "l_all_clients" not in who["perms"]:
        parts.append(f"""NOT EXISTS (SELECT 1 FROM ledger.client_access ca
            WHERE ca.client_id = {alias}.client_id
              AND ((ca.mode = 'restricted' AND NOT %s = ANY(ca.tech_ids))
                OR (ca.mode = 'group' AND NOT EXISTS
                     (SELECT 1 FROM shared.agent_groups ag
                       WHERE ag.agent_id = %s AND ag.group_id = ANY(ca.group_ids)))))""")
        args += [who["agent_id"], who["agent_id"]]
    return "(" + " AND ".join(parts) + ")", args


def _sane_span(started: str | None, ended: str | None):
    """Bug #27 guard: a mistyped year in a datetime-local field created a
    July 1930 entry — and with it a ghost billing period and timesheet.
    Spans must live in the present era."""
    from datetime import datetime, timedelta, timezone
    def parse(v):
        if v is None:
            return None
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(422, f"Unparseable timestamp: {v!r}")
    st, en = parse(started), parse(ended)
    now = datetime.now(timezone.utc)
    for label, dt in (("start", st), ("end", en)):
        if dt is None:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if dt.year < 2020 or dt > now + timedelta(days=400):
            raise HTTPException(422, f"That {label} time ({dt.date()}) is outside the "
                                     "sane window — check the year")


def _retainer_overage(cur, client_id, period_id, period_key):
    """Server-side mirror of the UI's retainerMath (core.js) — the ONE place
    the retainer agreement turns into a billed amount (audit 32g: it was
    persisted + displayed but applied to no billed total, so retainer clients
    were over-billed the full hours).

    Returns None when no retainer applies — the caller then bills normally.
    Applies (returns the overage breakdown) only when BOTH the retainers module
    is on (app_config 'retainers'.enabled — "turn off if Odoo owns agreements")
    AND the client has an ENABLED agreement. When it applies the period bills
    ONLY the overage hours (used − included) at the agreement rate; the covered
    hours are prepaid by the retainer fee (invoiced separately), exactly as the
    on-screen overage math shows.

    included = includedHours + a one-period rollover of the prior period's
    unused included hours, capped at rollover_cap_hours (mirrors prevPeriodKey/
    prevUsed). Overage rate = the agreement rate, else the client-wide rate
    override, else the UI's $150 fallback."""
    cur.execute("SELECT value FROM shared.app_config WHERE key = 'retainers'")
    row = cur.fetchone()
    module = row[0] if row and isinstance(row[0], dict) else {}
    if not module.get("enabled"):
        return None
    cur.execute("""SELECT included_hours, overage_rate_cents, rollover_cap_hours
                     FROM ledger.retainers WHERE client_id = %s AND enabled""",
                (client_id,))
    r = cur.fetchone()
    if r is None:
        return None
    included_hours, overage_rate_cents, rollover_cap = float(r[0]), r[1], float(r[2])

    def _billable_hours(pid):
        cur.execute("""SELECT COALESCE(sum(e.hours), 0)
                         FROM ledger.time_entries e
                         CROSS JOIN LATERAL ledger.priced(e) AS p
                        WHERE e.period_id = %s AND e.status <> 'void' AND p.billable""",
                    (pid,))
        return float(cur.fetchone()[0])

    used_h = _billable_hours(period_id)

    rollover_h = 0.0
    if rollover_cap > 0:
        # the immediately-preceding materialized period (key order = the UI's
        # sorted prevPeriodKey for same-cycle keys)
        cur.execute("""SELECT id FROM ledger.billing_periods
                        WHERE client_id = %s AND period_key < %s
                        ORDER BY period_key DESC LIMIT 1""", (client_id, period_key))
        prev = cur.fetchone()
        if prev is not None:
            prev_used = _billable_hours(prev[0])
            rollover_h = min(max(included_hours - prev_used, 0.0), rollover_cap)

    included_h = included_hours + rollover_h
    overage_h = max(used_h - included_h, 0.0)

    if overage_rate_cents is not None:
        rate_cents = int(overage_rate_cents)
    else:
        cur.execute("""SELECT rate_cents FROM ledger.client_rates
                        WHERE client_id = %s AND activity_type_id IS NULL
                          AND rate_cents IS NOT NULL
                        ORDER BY valid_from DESC LIMIT 1""", (client_id,))
        cw = cur.fetchone()
        rate_cents = int(cw[0]) if cw and cw[0] is not None else 15000

    return {"used_h": round(used_h, 2), "included_h": round(included_h, 2),
            "rollover_h": round(rollover_h, 2), "overage_h": round(overage_h, 2),
            "rate_cents": rate_cents, "amount_cents": round(overage_h * rate_cents)}


def _export_payload(cur, period_id):
    cur.execute("""SELECT bp.client_id, bp.period_key, bp.status, c.name
                     FROM ledger.billing_periods bp
                     JOIN shared.clients c ON c.id = bp.client_id
                    WHERE bp.id = %s""", (period_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(404, "No such period")
    client_id, period_key, status, client_name = row
    if status == "open":
        raise HTTPException(409, "Approve the period before exporting")
    # retainer clients bill ONLY overage (audit 32g): a single overage line at
    # the agreement rate instead of the per-activity-type ladder — the covered
    # hours are prepaid by the retainer fee (invoiced separately), exactly as
    # the on-screen retainerMath shows. Non-retainer clients bill as before.
    retainer = _retainer_overage(cur, client_id, period_id, period_key)
    if retainer is None:
        cur.execute("""
            SELECT at.name, p.rate_cents, round(sum(e.hours), 2)
              FROM ledger.time_entries e
              CROSS JOIN LATERAL ledger.priced(e) AS p
              JOIN ledger.activity_types at ON at.id = e.activity_type_id
             WHERE e.period_id = %s AND e.status <> 'void' AND p.billable
             GROUP BY at.name, p.rate_cents ORDER BY at.name""", (period_id,))
        lines = [{"name": n, "quantity": float(q), "price_unit": r / 100.0, "uom": "Hours"}
                 for n, r, q in cur.fetchall()]
        cur.execute("""
            SELECT COALESCE(sum(p.amount_cents), 0)
              FROM ledger.time_entries e
              CROSS JOIN LATERAL ledger.priced(e) AS p
             WHERE e.period_id = %s AND e.status <> 'void' AND p.billable""",
            (period_id,))
        hourly_cents = int(cur.fetchone()[0])
    else:
        if retainer["overage_h"] > 0:
            lines = [{
                "name": (f"Retainer overage — {retainer['used_h']:.2f} h used / "
                         f"{retainer['included_h']:.2f} h included"),
                "quantity": retainer["overage_h"],
                "price_unit": retainer["rate_cents"] / 100.0, "uom": "Hours"}]
        else:
            # under the retainer — one $0 line documents the coverage so the
            # draft invoice isn't empty (a bare no-line invoice reads as an error)
            lines = [{
                "name": (f"Within retainer — {retainer['used_h']:.2f} h used / "
                         f"{retainer['included_h']:.2f} h included (no overage)"),
                "quantity": retainer["used_h"], "price_unit": 0.0, "uom": "Hours"}]
        hourly_cents = retainer["amount_cents"]
    flat_cents = 0
    cur.execute("""
        SELECT fl.project_title, fl.line_label, fl.amount_cents
          FROM ledger.project_flat_lines fl
         WHERE fl.client_id = %s
           AND ledger.period_key_for(fl.client_id, fl.approved_at) = %s""",
        (client_id, period_key))
    for title, label, cents in cur.fetchall():
        flat_cents += cents
        lines.append({"name": f"{title} — {label}", "quantity": 1,
                      "price_unit": cents / 100.0, "uom": "Fee"})
    # the AUTHORITATIVE hourly total is the integer-cents figure computed above
    # (per-entry ledger.priced for a normal client, the overage amount for a
    # retainer one) — never a float recompute over the grouped lines, which
    # drifted by cents from every other money path (audit). Odoo's own draft
    # recompute of quantity×price_unit can still differ by a cent on grouped
    # lines; total_cents is the truth.
    total_cents = hourly_cents + flat_cents
    cur.execute("SELECT value FROM shared.app_config WHERE key = 'ledger'")
    row = cur.fetchone()
    cfg = row[0] if row and isinstance(row[0], dict) else {}
    return {"partner": client_name, "client_id": str(client_id), "period": period_key,
            "move_type": "out_invoice", "state": "draft",
            "currency": cfg.get("currency", "USD"),
            "invoice_line_ids": lines,
            "retainer": retainer,   # None for normal clients; overage breakdown otherwise
            "total_cents": total_cents,
            "total": total_cents / 100.0}
