# Hemingway Suite — Code Guide

How to read (and safely edit) this codebase. Companions: `DOCUMENTATION.md`
(what exists and what's next), `STATE.md` (punch list + the full bug ledger —
every convention below was paid for by a numbered bug in there).

## 1. Repo map

```
db/migrations/          numbered, append-only SQL — the most heavily commented
                        code in the repo; each file says WHY it exists
services/desk-api/      Docket: FastAPI app (app/*.py) + its UIs (webui/)
services/ledger-api/    Ledger: FastAPI app + its UIs
services/mail-worker/   no HTTP — a 30s loop: Graph ingestion, the automations
                        engine, SLA scanning
nginx/                  the real TLS-front config (the .example is superseded)
scripts/                operator helpers (token mint, deploy)
docs/                   this guide, DOCUMENTATION.md, STATE.md
```

Every Python module opens with a docstring stating its contract — read those
first; they are current. SQL migrations narrate their own reasoning inline.

## 2. The UI architecture (the part that surprises people)

`desk.html` and `ledger.html` are **single-file applications with two halves**:

1. **The prototype** — design tokens, stylesheet, a demo data model, and all
   view/render functions. It's the original clickable mock, still runnable
   standalone (`window.LIVE_MODE=false`).
2. **The live adapter** — the file's *final script block*. It hydrates the
   prototype's state from `/api/bootstrap` (the server deliberately speaks
   the prototype's vocabulary — bug #22) and mirrors every mutation by
   **wrapping** prototype functions: let the local function run, detect what
   changed, send the matching API call, hydrate on error.

This split is a feature, not debt: prototype functions stay pure and
demo-testable; all server knowledge lives in one findable place at the bottom
of each file. When adding behavior — local logic goes in the prototype half,
wiring goes in the adapter, never mixed.

Other load-bearing UI rules (each traces to a bug):
* `render()` is the only innerHTML rebuild, and it carries focus/caret/scroll
  across the rebuild (bug #26). Don't rebuild DOM elsewhere.
* Fetch paths are **absolute per origin** (bug #8). Ledger additionally
  prefixes `LBASE` (`/ledger` when served behind nginx) — every server call
  already funnels through one `$fetch`/`api()` helper per file; keep it so.
* Hydration failures are loud (title + alert), never silent staleness.

## 3. CSS conventions

Each stylesheet opens with its own organization map. The short version:

* **Design tokens** live in `:root` — recolor there, nowhere else.
* **One-off styling stays inline** next to its template-literal markup.
  With HTML generated in JS strings, locality genuinely beats a class nobody
  can find — this is deliberate, inherited from the prototypes.
* **A pattern used 3+ times gets extracted** to the UTILITIES section at the
  end of the sheet, with a comment saying what it's for (current set:
  `.card-head.flush`, `.in-mono` in Docket; `.chip.slim` in Ledger).
  Extraction is organization only — computed styles must not change.

## 4. Server architecture in one breath

One Postgres, four schemas (`shared`, `desk`, `ledger`, `audit`), three
least-privilege DB roles — **invariants live in the database** (guard
triggers, one-way period states, `ledger.priced()` as the sole pricing
authority), so the APIs stay thin routers with RBAC gates (`auth.need`) and
audit lines. The worker owns everything time-driven: ingestion, the
automations engine (event outbox, `SKIP LOCKED`), SLA scanning — and commits
ingestion **before** the engine passes so an engine failure can never roll
back mail (bug #29).

## 5. Editing checklist (the pre-ship audit battery)

Before any bundle ships, all of these run — do the same for your edits:
1. New SQL touching tables → verify grants (DML **and** cross-schema reads)
   against the migrations; DEFAULT PRIVILEGES covers new tables for the
   owning API role only.
2. New third-party import → is it in that service's `requirements.txt`?
   (bug #25 — a missing dep is a crash-looping container, not an error page.)
3. Every UI script block through a JS parser; every `.py` through
   `py_compile`; compose through a YAML load.
4. Every new fetch URL cross-checked against the route table.
5. Conventions: append-only migrations, no DELETE (void/archive), integer
   cents, effective-dated rates, secrets write-only, customer-touching
   features default-off, one-command deploys.
