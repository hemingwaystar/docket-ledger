# Build 12 — design contract (2026-07-31)

User asks, verbatim: (1) "apply that color swatch to priorities/sla too";
(2) "add a 'vip' checkbox to the user add/edit field and add automations so
that i can vip status for ticket triggers"; (3) rework Ledger's Billing
Periods page into "a full list of clients (searchable) that shows current
period status, but can be expanded for full billing period information
including historical periods (searchable)". House rules (REWORK-DESIGN
§0/§3, BUILD10/11 designs) stay binding. Migration 0028 is written — read,
don't modify.

## 1. Priority colors (desk.priorities.color, 0028)

* Same UX as state decor (11/11b): a swatch strip on each Priorities & SLA
  row — pills + the RGB square + ↺ default — mirroring IMMEDIATELY through
  the existing PATCH /api/settings/priorities/{id} with a new `color` key.
* **Priority palette = the four existing tier flag styles** `p1 p2 p3 p4`
  (css/desk.css .prio family — no new CSS colors), OR a `#rrggbb` hex.
  settings.py pins `PRIO_PALETTE = ("p1","p2","p3","p4")` next to
  ST_PALETTE, sharing the hex regex; state.js pins the literal twin.
* **One render seam**, like states: `prioTagAttrs(p)` (state.js) — stored
  hex → `class="prio hexed"` + inline `color:` (flag via
  `.prio.hexed .pflag{background:currentColor}` in desk.css utilities;
  text darkened like stChipAttrs); stored token → that class; NULL → the
  shipped rank-derived class, byte-identical to today. `prioTag`
  (render.js) and any direct `class="prio ${...}"` site route through it.
* Bootstrap priorities emission adds `color`; mapIn overlays (hex prop /
  cls token / rank-derived fallback). PATCH semantics identical to states:
  omitted = unchanged, explicit null = reset. NewPriority accepts color.

## 2. VIP contacts + trigger condition (shared.contacts.vip, 0028)

* **Directory**: the contact add/edit modals gain a "VIP" checkbox
  (contactFields/readContactFields/contactPayload + saveContact/
  saveContactEdit in views/clients.js); directory.py contact POST/PATCH
  accept `vip: bool` (default false on create; PATCH omitted = unchanged).
  Bootstrap contact rows emit `vip`.
* **Visibility**: wherever the ticket's contact renders as the case-file
  header/props contact line, a compact `★ VIP` chip appears when the
  contact is VIP (props panel contact row + the contacts list rows in the
  client view). Keep it subtle — a chip, not a banner.
* **Trigger condition**: new field `vip` in the trigger builder's
  condition field list (values: a yes/no select — stored as the strings
  "yes"/"no", ops is / is not). Worker engine: `_ctx` gains
  `contact_vip` (the existing contacts join adds co.vip); `_trig_cond`
  maps field 'vip' → "yes"/"no" before the normal any-of compare. Both
  docstrings (worker vocabulary contract + builder hint) updated
  together — one vocabulary, both sides (bug #22).
* Mail rules unchanged (the ask is ticket triggers).

## 3. Ledger Billing Periods page redesign

* `viewPeriods` (ledger views/periods.js) becomes a **searchable client
  list**: one row per non-sentinel client (search box filters by name;
  archived clients appear only when they have period history, dimmed).
  Each row shows: client name · cycle · CURRENT period (periodFor(cycle,
  NOW)) status chip (open/approved/exported via periodState) · current
  billable total (existing priced() math).
* A row **expands** (state.pf = {q:'', open:{}, hq:''}) to the full
  panel: the current period's detail (entry count, hours, billable
  total, the EXISTING wired actions — Approve & lock via approvePeriod,
  export via runExport, payload preview via previewPayload — behavior
  untouched, markup relocated) plus **historical periods**: every past
  period for that client derived from server PERIODS rows + entries
  (label, span, status, totals, exportRef when exported), newest first,
  with its own search/filter box (label/status text match, state.pf.hq).
* No new endpoints, no ledger backend changes: this is a view-layer
  reorganization over data already hydrated (PERIODS, state.periods,
  entries, projFlatLines). All period-key handling stays in UI keys with
  srvPeriodKey at the fetch boundary (rows 39/40 — do not regress this).
* CSS: any new list/expand styling goes in ledger.css's Docket-matching
  conventions (a small section; reuse existing card/row primitives).

## Verification

The standing battery + probes: prioTagAttrs hex/token/default transitions;
a VIP contact renders the chip and the trigger condition matches
yes/no correctly (engine reviewed line-by-line — no runtime available for
the worker); the periods page renders with zero/many clients, expansion
toggles, both searches filter, and the approve/export/preview actions are
byte-equivalent to build 11's (adversarial diff). 0028 needs no grants
beyond 0001 (verify). Deploy: 0028 before rebuilt containers (deploy.sh).
