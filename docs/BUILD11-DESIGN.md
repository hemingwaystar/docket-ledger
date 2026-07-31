# Build 11 — design contract (2026-07-31)

User asks, verbatim: (1) "Ticket list filtering: client based filter/list,
any advanced filter that could honestly be used for a ticket board/overview,
same as the config in the admin panel"; (2) ticket states: "change the color
of the state and the description"; (3) "queue by state" card: wrap the text
so it looks uniform. House rules (REWORK-DESIGN §0/§3, BUILD10-DESIGN
§Storage) stay binding.

## 1. Advanced filtering — one vocabulary, three consumers

* **OverviewDef gains `clients: [uuid, ...]`** (any-of, omitted/empty = no
  constraint). Touch points: `ovPred` (evaluator), the admin Queue-tabs
  card's criteria pickers (`ovModal`/`ovSummary`), the personal
  Customize-tabs "add a personal tab" pickers, and the §Storage vocabulary
  in BUILD10-DESIGN (append a note there referencing this file).
* **The queue filter bar reaches criteria parity with the tab config**:
  alongside the existing group/priority/client multiCombos it gains a
  **state** multiCombo (all states, archived rule as usual; system states
  ARE listed — filtering by 'Closed: child ticket' is legitimate), a
  **tag** multiCombo (options = the union of tags on currently loaded
  tickets), and an **owner scope** select (Anyone / Mine / Unassigned).
  All predicates: empty = all. `state.qf` grows `st: []`, `tag: []`,
  `scope: ''` — qfNorm covers the new arrays; ticketsCSVRows applies the
  same predicates (export = exactly what's shown).

## 2. State color + description (migration 0027)

* **Storage**: `desk.ticket_states.color` (palette token, NULL = default
  decor) + `.description` (free text, NULL = default). Migration 0027 is
  already written — do not modify it.
* **The palette is the UI's chip-style set, pinned BOTH sides** (bug #22):
  `ST_PALETTE` in state.js is the single frontend list — token → chip
  class + swatch label; settings.py validates `color` against the same
  literal token list (a comment in each file points at the other). Tokens
  are the existing desk.css chip classes for states (enumerate them from
  css/desk.css — the st-* family) — NO new CSS colors invented.
* **API**: NewState/PatchState gain `color: str | None` and
  `description: str | None` (PATCH: omitted = unchanged; explicit null =
  reset to default). Unknown token → 422 listing the palette. System
  states stay fully locked (422, as today). CORE states accept color and
  description — only their LABEL is protected (the worker resolves by
  label; decor is free).
* **Bootstrap** emits `color`/`description` per state; mapIn overlays them
  onto the shipped `ST_DECOR` defaults (stored value wins; NULL falls
  through). Every chip render site (queue rows, props panel, dashboard
  card, pickers) already goes through `stateChip`/`s.cls` — extend that
  one seam, not the call sites.
* **Settings states editor** gains swatches (the palette, current one
  ringed) + a description input; both mirror through the existing
  PATCH/POST with diff-guards. The state row subtitle renders the stored
  description (falling back to the shipped text for core states).

## 3. Queue-by-state card wrap

CSS-only presentation fix plus minimal markup: the card's rows become a
two-column grid — fixed-width label column (chip text wraps,
`white-space: normal`, consistent chip width) + the bar/count column — so
every bar starts at the same x regardless of label length. Lives in
css/desk.css (a card-scoped section, not a global chip change) + the row
template in views/dashboard.js.

## Deploy note

0027 must apply before the rebuilt containers serve the new bootstrap
(same class as 0026 — `./deploy.sh` order covers it).

## Verification

The build-10 battery, rerun: browser parse + empty-state renders + a
functional probe (set a state's color/description in local state and
assert stateChip reflects it; build an OverviewDef with clients and assert
ovPred filters); 44/44 .py compile; endpoint parity (only changed shapes:
states POST/PATCH); palette-list equality check between state.js and
settings.py; grants (0027 needs none beyond 0001).
