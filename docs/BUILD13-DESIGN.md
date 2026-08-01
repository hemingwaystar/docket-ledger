# Build 13 — design contract (2026-08-01)

User asks, verbatim-condensed: (1) fix the Ledger org "#undefined"; (2)
re-add global default billing rates "with a switch on each client to push
default billing rates but still allow to toggle on/off different work
types"; (3) roles deletable AND archivable ("no reason roles cant be
deleted, they dont hold any immutable information"); (4) group assignment
via a proper list/dropdown instead of checkboxes; (5) rework the local
password UI, fix local MFA, group assignment from the agent row with
multiple groups; (6) client website links auto-embed; (7) advanced ticket
filter + CSV export on the client page; (8) remove arbitrary UI (Graph
mail / Docket linked pills, "watch it land in ledger live", …); (9) remove
example text ("Pricing, approval and invoicing happen in Ledger", the VIP
explainer, …); (10) dashboard queue-by-state as a dropdown; (11) unify the
bottom-left card (Docket's styling wins); (12) unify sidebar icons
(Ledger's styling wins); (13) pagination — 10/25/50/100 — on every long
object list in both apps; (14) unify baked-in vs manual input fields
across all settings; (15) the "July 1930" period on the test client.

## Money lane (items 1, 2, 15 — migration 0029 + 0031)

* **zorg (row 45)**: bootstrap emits `zorg = str(id)[:8]`; renders say
  "client #"; suite-bridge derives instead of fabricating; preview and
  `_export_payload` both carry `client_id`.
* **Default rates (0029)**: `ledger.default_rates` (effective-dated,
  nullable rate_cents = dated unset) + `ledger.client_default_rate_optin`
  (two-lane per 0017: wide row = the client switch, typed rows = per-type
  opt-out). `priced()` re-issued = 0018 body + EXACTLY one gated rung
  between client-wide and type-base: client-specific rate → (opted-in AND
  type not toggled off) global default → type base → unbilled. UI ladder
  (core.js effRateN/effFlag) mirrors it as-of; Settings gains the
  Default-billing-rates card (write-gated any-of l_approve/l_export to
  match `auth.need`); the client page gains the switch + per-type toggles.
  Endpoints: PUT /api/default-rates/{type_id}, PUT
  /api/clients/{id}/default-rates. 13th ledger bootstrap key
  `defaultRates`. Accepted trade-off (mirrors put_type_rate): a type's
  FIRST-ever default rate anchors at epoch, so an opt-in that predates it
  back-prices the gated window — same anchor semantics as every rung.
* **1930 (rows 46/48, 0031)**: pfHistory skips void-only periods;
  articles.py ride-along span gets `_sane_span` (the fourth and last
  writer); 0031 tripwires (entries AND shells), re-dates the void garbage
  to created_at, deletes empty pre-2000 shells owner-level, adds era
  CHECKs, re-issues ensure_period with the era guard — RESTATING
  SECURITY DEFINER + search_path (0006's attributes; row 48).

## Directory lane (items 3, 4, 5 — migration 0030)

* **Roles**: archive/restore via PATCH `active` (core roles refuse);
  hard DELETE (the user-approved exception to the no-DELETE doctrine,
  roles ONLY) behind three guards: client live-member count, API holder
  check counting DEACTIVATED agents, and 0030's BEFORE DELETE trigger +
  minimal GRANT DELETE to desk_api. Archived roles stay in bootstrap with
  `active`; pickers filter them; a HOLDER's select shows the archived
  name disabled + "(archived)" (never lies with the first option).
* **Groups**: the checkbox matrix is gone; agent rows carry a
  multiCombo (chips + type-to-search, N:M membership) over the same
  full-list PATCH; membership still bridges to Ledger client access.
* **Local auth (row 47)**: per-agent Auth modal = password set/reset
  (temp shown once, readonly field, honest Copy), MFA status, admin
  reset, self-enroll. Two-phase TOTP: PENDING secret via session
  self-service (POST /auth/mfa/enroll + /confirm) or password-gated
  login-time enroll-start; login gate keys on totp_enrolled_at so
  pending never locks; failure audits COMMIT before their raise.
  Enrollment output on login.html enters the DOM via textContent;
  otpauth label email is URL-quoted. Non-admins under mfa=optional
  enroll at first sign-in after the flip to required (documented walk).

## UI lane (items 6–14)

* Website links: `webHref/webLabel` normalizer in desk core.js —
  https:// prefixed when bare, target=_blank, both apps' renders.
* Client-page tickets: queue's qf machinery reused (clf state, reset on
  client change in render.js), CSV export shares the queue's one CSV
  shape, gated on the export permission.
* Removals: Graph-mail/Docket-linked pills, suite banner, fake rail
  status lines, fake Sync now, explainer copy per the R-inventory
  (KEEP-verdict captions stating real behavior stay). Queue-by-state
  config (Settings + dashboard ⚙) → multiCombo dropdowns, save
  semantics unchanged.
* Parity: Ledger's bottom-left card = Docket's markup/CSS; Docket's nav
  icons redrawn in Ledger's stroke style (shared views byte-identical);
  one input style + `.ro` read-only look in both sheets; the
  Docket-connection field renders its baked-in host read-only.
* Pagination: one pager util per app (byte-identical contract;
  localStorage `dk.pgsz.*`/`lg.pgsz.*`, default 25, sizes 10/25/50/100,
  auto-hide ≤10, clamp-on-shrink), applied AFTER filters on 24 list
  sites; counters/CSV/bulk always read the FULL filtered set;
  timesheets selection is page-aware.

## Verification (how this build was proven)

Four read-only spec agents → nine implementers on disjoint file sets →
seven adversarial verifiers + a Python parse auditor. The verifiers ran
the full script chains in a real browser engine (zero errors both apps),
diffed priced() against the UI ladder case-by-case, and traced every new
fetch to its route and RBAC flag. 13 findings, all fixed pre-push — the
one blocker being row 48 (SECURITY DEFINER strip). py_compile could not
run locally (no interpreter); the deploy's container build is the final
Python gate — deploy watches step one: time logging still works.
Deploy: 0029→0030→0031 migrate before both containers rebuild
(deploy.sh order); then the STATE.md §5 build-13 walks.
