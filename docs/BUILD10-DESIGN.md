# Build 10 — design contract (five features, 2026-07-31)

User asks, verbatim: (1) a button to clear notifications; (2) modifiable ticket
groupings from filter criteria — admin-standardized, user-configurable; (3)
multi-select on filter dropdowns in reports/logs/automation settings etc.; (4)
per-board outbound routing address; (5) show/hide ticket-state queues on the
dashboard. Build-9 rules (docs/REWORK-DESIGN.md §0/§3) remain binding: one
function per control, mapIn consumes every bootstrap key, archive/void only,
loud failures, both sides of every wire speak the same vocabulary.

## Storage decisions

* **Admin defaults** live in `shared.app_config` under a new key **`desk_ui`**:
  `{"overviews": [OverviewDef, ...], "dashboardStates": [label, ...]}`.
  `desk_ui` joins CONFIG_KEYS in settings.py; edited via the existing
  `PUT /api/settings/config/desk_ui`; gets a Settings card.
* **Per-user prefs** live in `shared.app_config` under **`uprefs:<agent uuid>`**:
  `{"overviews": {"order": [id,...], "hidden": [id,...], "custom": [OverviewDef,...]},
    "dashboardStates": [label,...] }` (absent key = follow admin default).
  Written ONLY via **PUT /auth/me/prefs** (sessions.py — new endpoint; the
  server derives the uuid from the session, so nobody can write another
  user's prefs; body is the whole prefs object, upserted). Read path:
  bootstrap `me.prefs` (empty object when unset).
  `GET /api/settings/config` EXCLUDES `uprefs:%` keys from its listing.
* **OverviewDef** (the filter vocabulary — pinned, both sides):
  `{"id": slug, "label": str, "scope": "all"|"mine"|"unassigned",
    "stateKinds": ["open","paused","done"]?, "states": [label,...]?,
    "groups": [uuid,...]?, "prios": [rank,...]?, "tags": [str,...]?,
    "recentDays": int?}` — omitted key = no constraint. The FIVE current
  tabs (My assigned / Unassigned / All open / Pending·hold / Recently
  solved) are expressed in this vocabulary as the shipped default, so
  out-of-the-box behavior is byte-for-byte unchanged.
* OverviewDef additionally carries `clients: [uuid,...]` (any-of; build 11 — see BUILD11-DESIGN.md).

## 1. Bell — mark all read

`MarkRead` gains `all: bool = False`. When true, ignore `ids` and
`UPDATE desk.notifications SET read_at = now() WHERE read_at IS NULL AND
(<the exact visibility scope _notifs uses: mine OR global OR my groups>)`.
UI: a "Mark all read" button in the bell box header; optimistic badge zero,
oops on error. The per-item click-through behavior is unchanged.

## 2. Overviews (queue tabs)

`overviews()` in views/tickets.js becomes a pure evaluator of OverviewDefs:
effective list = admin `desk_ui.overviews`, reordered/hidden per
`me.prefs.overviews`, plus the user's `custom` defs at the end. Counting and
filtering logic translates OverviewDef keys onto the existing predicates
(scope→owner tests, stateKinds→st8().type, states→labels, recentDays→
updatedAt window). Settings gains an "Queue tabs" admin card (list, add,
edit, reorder, archive-style hide — wired to PUT config/desk_ui). The queue
gets a per-user "Customize tabs" affordance (reorder/hide/add personal tab —
wired to PUT /auth/me/prefs). No hardcoded tab list survives anywhere.

## 3. Multi-select dropdowns

* New `multiCombo` component per app (render.js): checkbox dropdown with
  chips, "All" = empty selection; keyboard/focus behavior copied from the
  existing combo (bug #26 rules).
* Filter bars move from scalar to array values (empty = all): desk queue
  (group/priority/client + state where present), desk reports, desk audit,
  ledger timesheets/approvals/client-detail/reports bars. Filter predicates
  become `arr.length===0 || arr.includes(v)`. The row-37 archived-entry
  rule carries over: archived entries stay out of the options unless
  currently selected (then "(archived)").
* Automation builders: condition VALUE pickers for list-valued fields
  become multi-select writing the engine's comma any-of form ("a, b, c").
  **Engine parity**: worker `_trig_cond` 'is'/'is not' adopt `_anyof`
  comma semantics (is = matches any; is not = matches none), exactly like
  mail rules already do — single old values parse identically (they're
  one-element any-ofs). Both builders' hint texts say values take commas.

## 4. Per-board outbound address (migration 0026)

* **db/migrations/0026_group_sendas.sql** (8b rules: BEGIN/COMMIT,
  idempotent): `CREATE TABLE IF NOT EXISTS desk.group_sendas (group_id uuid
  PRIMARY KEY REFERENCES shared.groups(id), mailbox_id uuid REFERENCES
  desk.mailboxes(id), updated_at timestamptz NOT NULL DEFAULT now())` +
  `GRANT SELECT ON desk.group_sendas TO mail_worker` (0005 DEFAULT
  PRIVILEGES cover desk_api; the worker grant must be explicit — grants
  battery). `mailbox_id NULL` = no override (clearing is an UPDATE to
  NULL; no DELETE, house rule).
* **Resolution order, BOTH resolvers** (desk-api tickets/articles.py reply
  path AND mail-worker automations.py `_trigger_email` — find each by
  grepping the `send_reply(` call sites): group_sendas override (if set
  AND that mailbox is outbound-eligible) → current fed-by derivation →
  current failure path. Server refuses (422) setting an override to a
  receive-only mailbox.
* **API**: `PATCH /api/settings/groups/{group_id}/sendas {"mailbox":
  "<address>"|null}` in settings.py — resolves address→mailbox id, gated
  `manage_settings`, audited ("Outbound sender overridden … / cleared").
* **Bootstrap**: GROUP_SENDAS emission resolves the override so the UI
  shows the effective sender; each row also carries `override: true|false`
  so the routing card can label derived vs overridden.
* **UI**: the Outbound-routing card rows gain a picker (options =
  outbound-eligible mailboxes + "derived (default)") calling the PATCH;
  display shows "derived from fed-by" vs "override" per row.

## 5. Dashboard queue-by-state show/hide

The Queue-by-state card renders active states minus hidden ones: hidden =
`me.prefs.dashboardStates` if present else admin `desk_ui.dashboardStates`
(both lists mean SHOWN labels; absent = all). A small ⚙ on the card toggles
per-user visibility (writes /auth/me/prefs); the admin default lives in the
Settings desk_ui card. States keep rendering by position; counts unchanged.

## Implementation notes (post-build, part of the record)

* OverviewDef additionally carries an optional `active: false` for the admin
  Settings card's archive-style hide; `effectiveOverviews()` filters it at
  the read seam (one resolver, `adminOverviews()`, feeds every consumer).
* Per-user prefs keys clear by sending `null` — `savePrefs` deletes
  null-valued keys before the PUT so the stored shape keeps §Storage's
  "absent = follow admin default" contract.
* Engine limitation, now surfaced honestly: the comma any-of wire form
  cannot carry a value whose own label contains a comma ("Acme, Inc.") —
  builder pickers disable such options with an explanatory title. The real
  fix (a JSON-array escape on both sides) is future work.
* The trigger engine's `_trig_cond` ALREADY had any-of semantics at HEAD —
  build 10 changed only the documented contract, zero runtime change.
* **Deploy order is load-bearing**: the new code queries desk.group_sendas
  unconditionally, so migration 0026 must apply before the rebuilt
  containers start. `deploy.sh` guarantees this (pull → migrate → rebuild);
  do not hand-run `up -d --build` before `migrate` on this drop.

## Verification (before push)

Browser harness parse + empty-state render for both apps (build-9 method);
Pyodide compile of every .py; route diff = old + exactly {PATCH
groups/{id}/sendas, PUT /auth/me/prefs} + MarkRead extension; grants check
for 0026 against the migrations; both-sides vocabulary checks (OverviewDef,
comma any-of, prefs shape); demo-grep still zero. Docs: chronology entry,
STATE.md §5 build-10 walks, DOCUMENTATION §4 API additions.
