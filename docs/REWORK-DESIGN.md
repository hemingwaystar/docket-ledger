# Build 9 — The Restructure (design contract)

This document is the binding contract for the build-9 rework. It was written after a
full survey of build 8b (see git history / DOCUMENTATION.md chronology). Scope, in the
user's words: *"all prototyping ripped out once and for all, all frontend wired to the
backend, separate the html files into css, js files, laid out on the whole project,
readable like a human wrote it, noted, verified, tested."*

## 0. What does NOT change

- **The database.** Schema, migrations 0001–0025, triggers, grants, roles — untouched.
  The DB layer is the healthiest part of the system; it holds live production data.
  New UI wiring uses only grants that already exist (0001 gives desk_api
  SELECT/INSERT/UPDATE on all of desk.* and shared.*). **No migration 0026 in this build.**
- **The API contract.** Every existing route keeps its exact path, method, payload,
  and response shape. Route *additions* are listed in §4; nothing is removed or renamed.
- **Load-bearing UI rules** (each paid for by a numbered bug):
  - `render()` is the only innerHTML rebuild and carries focus/caret/scroll across
    the rebuild (bug #26). One render target: `#content` (+ nav/title/badge).
  - Fetch paths are absolute per origin (bug #8); Ledger prefixes `LBASE` inside its
    single `$fetch` helper and nowhere else.
  - Hydration failures are LOUD: ⚠ in the title + alert (bug #13). Never silent.
  - Inline `onclick="fn(...)"` handlers inside template literals, global functions.
    This is what makes innerHTML rebuilds safe. `jsq()` escaping stays.
  - No DELETE anywhere: archive/void semantics only (row 35: a button with no
    legitimate mirror target is a lie by construction).
- **Deployment topology.** compose, Dockerfiles, nginx config unchanged (webui/ is
  still COPYed into images — a UI change still requires an image rebuild).
- The two-tier UI (fallback `/ui/index.html` shells + full apps) stays.

## 1. What dies

The **prototype/adapter split** in desk.html and ledger.html: the demo data model,
`LIVE_MODE`, `seed()`, the demo toolbars and simulators, the persona switcher, the
in-page `DocketAPI`/`LedgerAPI` mocks, and the entire "final script block" adapter
that wrapped prototype functions to mirror them. **The new architecture has ONE code
path per control**: the function that handles a control updates local state AND calls
the API in the same body. A control without an API call is now visibly incomplete in
its own source file — the silent-control bug class (ledger rows 34/35/37/38) becomes
impossible by construction.

## 2. Target file layout

```
services/desk-api/webui/
  desk.html      login.html      index.html      suite.html      # markup shells only
  css/desk.css   css/login.css   css/index.css   css/suite.css
  js/login.js    js/index.js     js/suite.js
  js/desk/
    core.js        # clock (NOW = new Date()), esc/jsq, formatters, IC icons
    state.js       # state object + collections (ALL START EMPTY) + static catalogs
                   # (PERM_CATALOG, TRIG_EVENTS, PROJ_TEMPLATES, ENTRA_COLMAP,
                   #  NAV, PAGES) + can()/canView() RBAC + biz-hours/SLA math
    api.js         # $fetch, mapIn, hydrate, oops, srvId/isUuid/iso/typeName
    render.js      # render(), renderNav(), router (go/openTicket/openClient),
                   # modal, combo, toast, global search, bell, focus preservation
    views/dashboard.js  views/tickets.js   views/props.js     views/clients.js
    views/reports.js    views/projects.js  views/roles.js     views/automations.js
    views/directory.js  views/settings.js  views/audit.js
    newticket.js   # new-ticket modal, CSV/Entra import, contact & client modals
    suite.js       # bridgeSend + message listener + openLedger
    boot.js        # first hydrate, focus-rehydrate listener, notification poller
services/ledger-api/webui/
  ledger.html    index.html
  css/ledger.css css/index.css
  js/index.js
  js/ledger/
    core.js        # NOW, time/money/period/pricing/retainer helpers
    state.js       # state (EMPTY collections) + catalogs + RBAC
    api.js         # LBASE, $fetch, mapIn, hydrate, oops, srvPeriodKey, debounce helpers
    render.js      # render/renderNav/softRerender, modal/toast, combos, pgTitle
    views/dashboard.js   views/timesheets.js  views/approvals.js  views/clients.js
    views/types.js       views/periods.js     views/reports.js    views/audit.js
    views/directory.js   views/settings.js
    suite-bridge.js
    boot.js
```

Script tags load in exactly this order (core → state → api → render → views/* →
feature extras → boot). Plain classic scripts — **no ES modules, no bundler, no
framework**: every top-level `function`/`const` is intentionally global, because the
template-literal `onclick` architecture requires it. Views load in the order of the
layout listing above (not alphabetical); no parse-time dependency exists between view
files — cross-file references happen inside function bodies, resolved at call time.
(Naming note: the suite shell's script is `js/suite-shell.js` — `js/desk/suite.js` is
the in-app Docket↔Ledger bridge, a different file; the name difference is deliberate.)

Each JS file opens with a comment block stating: what it renders/owns, which server
endpoints it calls (the file IS the control→endpoint map now), and any invariants.
CSS files keep the section-map comment convention and `:root` design tokens.
One-off styling stays inline next to its markup (deliberate, see CODE-GUIDE §3).

## 3. Transformation rules (per function)

R1. For every function the old adapter **wrapped**: produce ONE merged function =
    original local logic + the wrapper's API call, preserving (a) optimistic order —
    local state first, then fetch; (b) the wrapper's diff-guard — only fire the API
    call when local state actually changed (row 21's lesson); (c) exact endpoint,
    method, payload keys, and response handling; (d) `oops(...)` (alert + rehydrate)
    on error. The old `approvePeriod` polling hack (250 ms watcher) is replaced by
    calling the API directly in the modal-confirm callback — now possible because we
    own the function.
R2. For every function the old adapter **replaced outright** (desk: attOpen,
    graphConnect, graphReconsent, vfySend, vfyCheck): keep ONLY the adapter version;
    delete the prototype body entirely (including the "Demo" banner in the old vfySend).
R3. Functions that were **local-only** (unwired): resolve per the fix list in §5 —
    wire, convert to read-only truth, or remove. None may survive as silent lies.
R4. Collections start EMPTY (`[]`/`{}`); `mapIn()` remains the single place bootstrap
    data enters state, and must consume EVERY key the server emits (desk: 20 keys,
    ledger: 10 — hydration-completeness, row 36). Until the first hydrate resolves,
    `#content` shows a plain "Loading…" card; hydration failure shows the loud error.
R5. Keep bug-number comments where code embodies a lesson; delete comments that
    narrate the old prototype/adapter history. Write file-top contracts. Do not
    write comments explaining that something "was moved" or "used to be" — the code
    reads as if it were always built this way. Keep comment density matching the
    existing style (sparse, load-bearing).
R6. Ship NO fake data: no demo names, tokens, titles, signatures, mails, personas.
    grep targets that must be ZERO in webui/ after the rework:
    LIVE_MODE, seed(, DEMO_MAILS, demoIncoming, demoPool, demoNewEntry, demoTechId,
    PERSONAS, setPersona, Jordan Doyle, Mara Ellison, Priya Nadkarni, Sam Okafor,
    Northwind, Cobalt Fabrication, Rivera Family, Harborline, Meridian Dental,
    dk_live_, PROTOTYPE-open-me-first, hemingwaytech.io, roleAccessCard,
    window.DocketAPI, window.LedgerAPI

## 4. Backend changes

**desk-api** — `app/tickets.py` (1,175 lines) becomes package `app/tickets/`:
`common.py` (TICKET_SELECT, ST_MAP, emit_event, sys_note, live_parent_of),
`read.py` (list/get/queue-report/audit), `bootstrap.py` (GET /api/bootstrap + /api/meta),
`write.py` (create/patch/reclient/tags), `time.py` (_sane_span/add/patch),
`merge.py`, `links.py` (0025 trio), `articles.py` (composer). `__init__.py` exposes
the routers; `main.py` includes them in the same order as today. Pure mechanical move —
byte-identical SQL and logic; only imports/module boundaries change.

**ledger-api** — `app/main.py` (965 lines) becomes: `main.py` (app assembly, health,
/me, / redirect, static mount LAST), `bootstrap.py`, `helpers.py` (_sane_span,
_export_payload), `entries.py`, `reports.py`, `timesheets.py`, `periods.py`,
`admin.py` (config/secrets/clients/types/rates/access). Same mechanical rule.

**New endpoints** (settings.py, all `auth.need('manage_settings')`-gated, audited,
archive-first, following the file's existing style):
- `POST /api/settings/states` · `PATCH /api/settings/states/{state_id}` — create /
  rename / archive / restore / reorder ticket states. Refuse edits to `is_system`
  rows (422, matching 0025's UI contract); `kind` is immutable after create.
- `POST /api/settings/priorities` · `PATCH /api/settings/priorities/{priority_id}` —
  label / rank / active only. **The SLA-hours columns on desk.priorities are 0001
  relics — SLA config lives in app_config (0020); do not surface them.**
- `GET /api/settings/tokens` — metadata only (name, created, last_used; never a
  token value). No mint/revoke endpoints: PATs remain operator-minted
  (scripts/create-token.sh) by convention.

**Bootstrap additions** (tickets/bootstrap.py): emit `priorities` (id, label, rank,
active); agents rows gain `hasPassword` (password_hash IS NOT NULL) and `mfa`
(totp_enrolled_at IS NOT NULL). Everything else byte-identical.

**scripts/deploy.sh** — created at last (bug #10's one-command deploy, referenced by
the docs for months but never written): `set -eu`, cd to repo root, `git restore .`,
`git pull`, `sudo docker compose run --rm migrate`, `sudo docker compose up -d --build
desk-api ledger-api mail-worker`, `sudo docker compose ps`.

**Hygiene:** __pycache__ dropped from the bundle; `.gitignore` gains `__pycache__/`.

## 5. Enumerated fix list (every deliberate behavior change in this build)

Desk:
 D1. `hydrate()` set `state.view='queue'` — no such view; now `'tickets'`.
 D2. `checkSlaEscalations` no-op + its 1 Hz call in `tickTimer` removed (server owns SLA).
 D3. `openLedger()` fallback opened `PROTOTYPE-open-me-first.html`; now opens
     `/ledger/ui/ledger.html` (or `:8082` origin-adjusted) when not inside suite.html.
 D4. Settings "API access" card: fake token/mock "Try it" replaced by a read-only
     list from `GET /api/settings/tokens` + a note that minting is operator-side.
 D5. Ticket-states editor wired (new endpoints above); Delete buttons removed
     (archive only); system states excluded from editing per 0025.
 D6. Priorities editor wired (label/rank/active); PRIOS hydrates from bootstrap.
 D7. Role editor: Entra group input renders the hydrated value (`roleDefs[].entra`);
     Ledger permission columns render from `roleDefs[].perms` (l_*) and toggle through
     the same `PATCH /api/directory/roles/{name}` as desk perms; `applyPreset`
     routes through the wired save path. LEDGER_ROLE_PERMS/LEDGER_PERMS demo tables die.
 D8. Directory agent rows: password/MFA badges render from bootstrap `hasPassword`/
     `mfa` flags (AGENT_AUTH demo table dies); "Reset password" wires to
     `POST /auth/admin/set-password`, "Reset MFA" to `POST /auth/admin/reset-mfa`.
 D9. Group Send-As display becomes read-only derived truth (it is configured via the
     wired Mailboxes card); the phantom editor and BOARD_SIGS/AGENT_SIGS signature
     editors are removed. **Composer output is byte-identical** — signatures-in-mail
     is a future build (desk.signatures schema exists, nothing consumes it).
 D10. `TITLES` demo map starts empty (17 fake titles die).
 D11. Suite bridge posts with explicit `location.origin` instead of `'*'`.
 D12. The prototype's client-side automation EXECUTION engine dies (applyAutomations,
      fireTriggers, trigger/rule condition matchers, GROUP_RR round-robin state,
      routeSender, DEMO_MAILS/demoIncomingEmail): the server has owned execution
      since 0019 (worker engine + outbox). The rule/trigger BUILDERS and their CRUD
      wiring stay exactly as wired. Same reasoning as D2.
 D13. The note/article EDIT control (saveEditArt + its pencil UI) dies: desk.articles
      are immutable by DB design; the control was prototype-only and could only lie.
      Composer, canned-insert (a local text convenience) and attachments stay.
 D14. SLA + business-hours editors mirror by DIRECT API calls (PUT /api/settings/
      config/sla, .../config/business_hours) instead of the old adapter's log()-
      string-sniffing hack; identical payloads, honest code path.
 D15. RESOLVED: the server's PatchTicket model has no `cc` field, so the composer's
      Cc editor (which the old adapter never persisted — a local-only illusion wiped
      on rehydrate) is REMOVED, along with the board-signature append (BOARD_SIGS was
      keyed by demo group ids that never matched server groups). The ticket Cc list
      is server-owned; replies mail the stored list. The agent signature line in the
      composer is unchanged.
 D16. archivePrio no longer locally re-points mailbox default priorities (the old
      re-point was never mirrored — an illusion). Archived tiers vanish from pickers;
      a mailbox keeping an archived default keeps it until edited in the (wired)
      Mailboxes card.
 D17. secretSave now validates (≥8 chars) BEFORE the PUT — the old adapter mirrored
      even values the local guard refused. Deliberate fix, not a faithful port.
 D18. Duplicate-definition cleanup after the split: saveTitle lives ONLY in
      views/props.js; the caller-verification trio (verifyModal/vfySend/vfyCheck)
      lives ONLY in views/props.js. One name, one home.
Ledger:
 L1. `setAF` double-declaration resolved: Approvals keeps `state.af`/`setAF`; Audit
     gets `state.auf`/`setAuf` with its own clear. (Was: hoisting collision + shared
     state corrupted filters between the two views.)
 L2. `state.projects` declared in initial state; bootstrap `projects` always hydrates
     (was silently discarded → project flat-fee pricing never saw server data).
 L3. Dead cluster removed: roleAccessCard, toggleRoleOpen, toggleTechRole,
     toggleRolePerm, applyRolePreset, syncPersonaPerms, setAllRolesOpen (the Ledger
     role page was dropped by decision — DOCUMENTATION §"dropped").
 L4. `approvePeriod` mirrors at modal-confirm (kills the 60 s polling watcher).
 L5. `state.demoTechId` renamed `state.myTechId`, set only from bootstrap `me`.
 L6. Random `ODOO-INV-…` refs in runExport die; the export ref comes from the server
     response (mark-exported), which was already recorded. runExport is therefore
     server-first — a documented R1 exemption — with LOUD failure paths (no silent
     no-op returns).
 L7. Ledger bootstrap now emits `groups`, `roles` (stripped l_* perms) and real
     per-tech group memberships (was hard-coded `[]`): the Directory mirror, the
     Approvals group filter and group-based client access work on a fresh load
     instead of waiting for a Docket suite-bridge broadcast. 12 bootstrap keys.
 L8. The period-lock registry (`state.periods`) is canonicalized on the UI's
     M/W-prefixed keys: mapIn translates server keys once (`uiPeriodKey`), and the
     two Periods-page server calls translate back (`srvPeriodKey`) at the fetch
     boundary. This closes gap #4 FOR REAL — the old adapter seeded the registry
     under server keys no reader could ever look up (inherited defect: server-
     approved periods rendered "Open", Periods-page approve/export never reached
     the server; the Approvals page was unaffected).
 L9. The `biweekly` billing cycle is removed from the UI (client cycle + default
     cycle selects): the server has no biweekly period (0003 files weekly/else-
     monthly), so the option could only ever lie. Stray 'B' keys map to monthly.
 L10. A "Billable by default" toggle is added to the client billing card, wired to
     the existing PATCH — `toggleClientBillable` existed and was adapter-wrapped
     but NO control ever invoked it, in the prototype or live (orphan silent
     control, now honest).
Both:
 B1. Stale "Phase 1 wiring" header comments die with the adapter blocks.
 B2. Served-UI staleness check markers move: the runbook grep is now
     `grep -c "Add person" services/desk-api/webui/js/desk/views/directory.js`
     and the curl equivalent under `/ui/js/desk/views/directory.js`.

## 6. Verification battery (all must pass before the bundle ships)

 V1. Every .js and inline script parses (real JS engine).
 V2. Every name referenced by an inline `on*=` handler in any template literal or
     shell resolves to a defined global function.
 V3. Every fetch URL (method + path) cross-checks against the server route tables —
     desk and ledger — including the three new endpoints. Zero unknown routes.
 V4. Endpoint-coverage diff: the set of endpoints called by the new UI ⊇ the old
     adapter's set (desk 51 patterns, ledger 17), minus none, plus exactly the
     §4 additions.
 V5. The §3-R6 greps return zero hits in webui/.
 V6. Hydration completeness: every bootstrap key consumed; every rendered collection
     fed from a hydrated source (no module-scope constant that bootstrap never fills,
     except static vocabularies/catalogs listed in state.js's header).
 V7. Every .py compiles (py_compile or equivalent); compose YAML loads; migrate.sh
     untouched byte-for-byte; migrations untouched byte-for-byte.
 V8. Route-table diff on the backend split: identical (method, path, status codes)
     before vs after, plus the three additions.
 V9. Handler/behavior spot review: for a sample of ≥15 merged functions per app,
     line-by-line equivalence review against the old prototype+wrapper pair.
```
