# Hemingway Suite — Code Guide

How to read (and safely edit) this codebase. Companions: `DOCUMENTATION.md`
(what exists and what's next), `STATE.md` (punch list + the full bug ledger —
every convention below was paid for by a numbered bug in there), and
`REWORK-DESIGN.md` (the build-9 restructure contract: what changed and why).

## 1. Repo map

```
db/migrations/          numbered, append-only SQL — the most heavily commented
                        code in the repo; each file says WHY it exists
services/desk-api/      Docket: FastAPI app (app/*.py; tickets are a package,
                        app/tickets/*) + its UIs (webui/)
services/ledger-api/    Ledger: FastAPI app (app/*.py, one module per concern)
                        + its UIs
services/mail-worker/   no HTTP — a 30s loop: Graph ingestion, the automations
                        engine, SLA scanning
nginx/                  the real TLS-front config (the .example is superseded)
scripts/                operator helpers (token mint, deploy.sh, SQL audit)
docs/                   this guide, DOCUMENTATION.md, STATE.md, REWORK-DESIGN.md
```

Every Python module opens with a docstring stating its contract — read those
first; they are current. SQL migrations narrate their own reasoning inline.

## 2. The UI architecture (build 9)

Since build 9 there is **no prototype half and no adapter**: each app is a
markup shell + one stylesheet + plain classic scripts, loaded in dependency
order. desk.html/ledger.html contain zero logic and zero styles.

```
webui/
  desk.html                 the shell: head, static chrome, ordered <script src> tags
  css/desk.css              the whole stylesheet (self-documenting section map)
  js/desk/core.js           clock, escaping, formatters, icons
  js/desk/state.js          state + collections (ALL start empty) + static catalogs + RBAC
  js/desk/api.js            $fetch · mapIn (the ONLY place bootstrap data enters state)
                            · hydrate (loud-failure armor) · shared server helpers
  js/desk/render.js         render()/renderNav() · router · modal/combo/toast · bell/search
  js/desk/views/*.js        one file per view: its render functions AND its actions
  js/desk/newticket.js      the new-ticket modal
  js/desk/suite.js          the Docket↔Ledger postMessage bridge
  js/desk/boot.js           first hydrate, focus-rehydrate, notification poller
```
(Ledger mirrors this under js/ledger/; its api.js adds period-key translation —
`srvPeriodKey`/`uiPeriodKey` — because UI period keys carry a cycle prefix.)

The rules that make this safe:

* **One function per control.** The function a control invokes updates local
  state AND calls the API in the same body: local mutation first (optimistic),
  a diff-guard so a no-op click never calls out, `oops()` (alert + rehydrate)
  on error. There is no wrapper layer to forget — a control without a fetch is
  visibly incomplete in its own file. This is what killed the silent-control
  bug class (ledger rows 34–38).
* **Every file opens with its contract**: what it owns and which endpoints it
  calls. The js/ tree IS the control→endpoint map — grep a path to find its
  one owner.
* **No modules, no bundler, no framework — deliberately.** Rendering is
  template literals with inline `onclick="fn(...)"`; that requires globals, and
  globals require nothing to build or install. `jsq()` escapes user strings
  embedded in handlers.
* `render()` is the only innerHTML rebuild and carries focus/caret/scroll
  across the rebuild (bug #26). Don't rebuild DOM elsewhere. `#content` shows
  a Loading card until the first hydrate lands.
* `mapIn()` must consume EVERY key bootstrap emits (desk 20, ledger 12) and
  every rendered collection must be fed by it — hydration-completeness, row 36.
  Collections start empty; there is no seed data anywhere.
* Fetch paths are **absolute per origin** (bug #8). Ledger prefixes `LBASE`
  inside its single `$fetch`; nothing else touches the base.
* Hydration failures are loud (⚠ title + alert), never silent staleness (#13).
* No DELETE controls: archive/void only (row 35 — a button with no legitimate
  mirror target is a lie by construction).

## 3. CSS conventions

Each stylesheet opens with its own organization map. The short version:

* **Design tokens** live in `:root` — recolor there, nowhere else.
* **One-off styling stays inline** next to its template-literal markup.
  With HTML generated in JS strings, locality genuinely beats a class nobody
  can find — this is deliberate.
* **A pattern used 3+ times gets extracted** to the UTILITIES section at the
  end of the sheet, with a comment saying what it's for. Extraction is
  organization only — computed styles must not change.

## 4. Server architecture in one breath

One Postgres, four schemas (`shared`, `desk`, `ledger`, `audit`), three
least-privilege DB roles — **invariants live in the database** (guard
triggers, one-way period states, `ledger.priced()` as the sole pricing
authority), so the APIs stay thin routers with RBAC gates (`auth.need`) and
audit lines. desk-api's ticket surface is the `app/tickets/` package (read /
bootstrap / write / time / merge / links / articles over shared `common.py`);
ledger-api is one module per concern with the static mount registered last.
The worker owns everything time-driven: ingestion, the automations engine
(event outbox, `SKIP LOCKED`), SLA scanning — and commits ingestion **before**
the engine passes so an engine failure can never roll back mail (bug #29).

## 5. Editing checklist (the pre-ship audit battery)

Before any bundle ships, all of these run — do the same for your edits:
1. New SQL touching tables → verify grants (DML **and** cross-schema reads)
   against the migrations; DEFAULT PRIVILEGES covers new tables for the
   owning API role only.
2. New third-party import → is it in that service's `requirements.txt`?
   (bug #25 — a missing dep is a crash-looping container, not an error page.)
3. Every UI script through a real JS parser (load the shell in a browser and
   read the console); every `.py` through `py_compile`; compose through a
   YAML load.
4. Every new fetch URL cross-checked against the route table.
5. Every new control: does its function contain both the local mutation and
   the fetch? Does bootstrap emit what its render reads (incl. any id the
   mirror needs — the states editor's `sid` was the cautionary tale)?
6. Conventions: append-only migrations, no DELETE (void/archive), integer
   cents, effective-dated rates, secrets write-only, customer-touching
   features default-off, one-command deploys (`scripts/deploy.sh`).
