# Build 27 — Assets: the suite's third app (foundation + the app itself)

Assets is the ITAM app next to Docket and Ledger: hardware/CI inventory,
software & licenses, vendor contracts & warranties, per-client cost reporting.
Scope decisions locked with the user (2026-08-20, from the prototype sessions):

* **Assets = pure ITAM.** Service catalog, incidents/requests, changes/CAB all
  live in Docket — none of that gets tables or endpoints here.
* **Terms are typed, not picked from vendor defaults.** Every license and
  contract carries `term_months` (free entry: monthly = 1, 1/2/3/4/5-yr = 12/24/
  36/48/60, anything 1–120) plus a `recurring` flag for auto-renewing
  agreements. Cost is **per term, billed up front at term start** — no
  amortization; a "monthly" charge is just a 1-month recurring term.
* **Lapse tickets (Build 30):** 60 days (configurable) before an asset's
  warranty ends or a NON-recurring license/contract term ends, a Docket ticket
  is raised — no owner, no contact, client = the record's client, filed to a
  configurable group (user's "Alerts" board). Config lives in app_config key
  `assets` and is editable on the Assets Settings page.
* **Permissions ("relatively complete"):** nine `a_*` ids (catalog below) —
  finer than view/manage, no per-client access modes.

## The build program (this file is the design of record for all of it)

| Build | Scope |
|---|---|
| **27 (this one)** | migration 0037 (schema, role, grants, CHECK widenings, perm seed), assets-api service + webui, suite shell third tab, roles-matrix third column, compose/nginx/deploy plumbing |
| 28 | Docket "affected CI": desk.ticket_assets child table (0032 pattern), PUT full-replace endpoint, ticket Properties/blocks UI, cross grants both ways |
| 29 | Ledger cost lines: ledger.cost_lines (period_id FK + ensure_period trigger + its own immutability guard), a_post_charges/l-side endpoint, the five seams (periods aggregate, export payload, bootstrap, UI tallies, cost-only-period visibility) |
| 30 | Coverage-lapse scan: fenced pass in mail-worker's loop + assets.lapse_notices dedupe table (sla_notices pattern); recurring items auto-advance their term at rollover |

## 0037_assets_init.sql (transactional + idempotent, build-8b rules)

1. **CHECK widenings** (hard blockers found in recon): `shared.permissions.app`
   allows only ('desk','ledger') and `audit.events.app` only
   ('desk','ledger','mail','auth','system') — both constraints are dropped and
   re-added with 'assets'.
2. `CREATE SCHEMA assets` + tables:
   * `assets.assets` — ci_tag UNIQUE, name, atype (checked list), client_id →
     shared.clients, assigned_to, status inuse|stock|repair|retired, serial,
     vendor, purchased_on, warranty_until, cost_cents, note, archived_at,
     version + touch trigger.
   * `assets.licenses` — product, vendor, client_id NULLable (NULL = MSP-wide),
     seats_total/seats_used, term_months, recurring, term_started_on,
     cost_cents (per term), note, archived_at, version + touch.
   * `assets.contracts` — vendor (agreement name), kind
     support|warranty|retainer|other, client_id, scope_note, term_months,
     recurring, term_started_on, cost_cents (per term), archived_at, version +
     touch.
   * `assets.contract_assets` — membership join (contract_id, asset_id) with
     GRANT DELETE (replace-style link table, 0011 doctrine).
   * `assets.asset_events` — the per-entity attributed event feed (Docket's
     sys-article pattern is ticket-bound, so Assets gets its own): kind
     asset|license|contract, entity_id, author, author_id → shared.agents,
     body, created_at. Dual-audit doctrine (build 22): every mutating endpoint
     writes BOTH an asset_events row AND audit.events app='assets'.
3. **Role `assets_api`** (NOINHERIT LOGIN, DO-block guarded): USAGE on
   shared/assets/audit; SELECT on ALL shared.* (sessions validation — the
   ledger read-only precedent, 0005); UPDATE(last_used_at) on
   shared.api_tokens; S/I/U on ALL in assets; INSERT+SELECT on audit.events;
   sequence USAGE; ALTER DEFAULT PRIVILEGES for future assets/shared/audit
   tables. NO DELETE anywhere except assets.contract_assets.
4. **Permission catalog** (app='assets', a_-prefixed like ledger's l_):
   * Visibility: `a_view` (see the app), `a_see_costs` (money columns)
   * Inventory: `a_manage_assets`, `a_manage_licenses`, `a_manage_contracts`
   * Billing: `a_post_charges` (consumed in Build 29; seeded now so the matrix
     is complete from day one)
   * Admin: `a_export_csv`, `a_view_audit`, `a_manage_settings`
   Presets: Admin = all nine (explicit — the 0002 CROSS JOIN was one-time);
   Dispatcher = a_view, a_see_costs, a_export_csv; Technician = a_view,
   a_manage_assets; Customer = none.
5. app_config seed `assets`:
   `{"lapse_lead_days": 60, "lapse_group": "Alerts", "lapse_kinds": {"warranty": true, "license": true, "contract": true}}`
   (worker consumes it in Build 30; Settings page edits it now).

## Out-of-migration plumbing (each hardcoded list found in recon)

* `db/migrate.sh` — password loop gains `assets_api`.
* `docker-compose.yml` — assets-api service (:8083→8000, DATABASE_USER
  assets_api, no KEK — it seals nothing), secret `pg_assets_api_password`
  (also added to the migrate service's secrets list + the secrets block).
* `scripts/deploy.sh` — `up -d --build` list gains assets-api.
* `nginx/helpdesk...conf` — `upstream assets_api :8083` +
  `location /assets/ { proxy_pass http://assets_api/; }` (prefix-stripped,
  the /ledger/ pattern).
* `secrets/README.md` + `README.md` — the five-file list becomes six.

## services/assets-api (ledger-api's shape, cloned)

* `app/auth.py`, `app/db.py` — byte-identical copies (house convention: each
  service carries its own). assets-api NEVER mints sessions — read-only
  validation of the shared hts_session cookie, login stays desk-owned.
* `app/main.py` — routers with absolute /api paths, /healthz, /readyz
  (SELECT over assets.assets), /me, / → /ui/assets.html, NoCacheStatic /ui
  mounted LAST.
* `app/helpers.py` — `event()` (asset_events writer), `cap_text`, date/term
  validators, `ms()`.
* `app/bootstrap.py` — GET /api/bootstrap, 8 keys: me, clients (light),
  assets, licenses, contracts (assetIds embedded), events (recent 400),
  audit (app IN ('assets','auth'), actor resolved to display name — the
  Docket JOIN pattern), cfg. mapIn() consumes every key (row-36 law).
* `app/items.py` — POST /api/assets (a_manage_assets), PATCH /api/assets/{id}
  (version-locked, 409 on conflict; archive via {archived}).
* `app/licenses.py` — POST/PATCH /api/licenses (a_manage_licenses).
* `app/contracts.py` — POST/PATCH /api/contracts (a_manage_contracts) +
  PUT /api/contracts/{id}/assets (full-replace membership, set_assignees
  pattern: no version predicate, validates ids, event + audit).
* `app/admin.py` — PUT /api/config/assets (a_manage_settings).
* Every ENTITY write (asset/licence/contract): business write → asset_events
  row (author = who.name||label, author_id or NULL for PATs) →
  auth.audit(conn,'assets',...) in the same transaction → returns
  {version, updatedAt} where the row is version-locked. The config write
  (PUT /api/config/assets) audits to audit.events only — app_config is not
  an inventory entity (ledger's put_config precedent).
* Reads are require()-only (house convention — visibility perms are UI-side
  suite-wide); every WRITE is need()-gated. PATs pass need() by doctrine.

## webui (assets.html + css/assets.css + js/assets/*)

Prototype (hemingway-assets-prototype.html) is the visual source — its CSS is
already the ported suite design system. Internal 'registry' keys from the
prototype are NOT carried over; everything is named assets.
Views: overview, assets, licenses, contracts, reports, audit, settings.
* ABASE mirrors LBASE ('/assets' behind nginx, '' on :8083).
* perms are used UNSTRIPPED (`can('a_view')`) — ledger's l_-strip lets desk
  ids leak into its stripped set (recon finding); assets doesn't copy that.
* Money columns render only with a_see_costs. CSV export gated a_export_csv.
* Term UI: number + months/years unit + recurring checkbox; displays
  'Monthly', 'N-mo', 'N-yr' + '↻ recurring'; annualized = cost/term×12.
* Audit view ports Ledger's (with its entity/entityId filter bug fixed).
* suite-bridge: accepts relayed {src:'docket'} dir-client-upsert/dir-snapshot
  (clients only) as live supplement; bootstrap is the durable feed.

## Suite shell (desk-api/webui)

suite.html gains the Assets tab + third pane/iframe (src resolution:
'/assets/ui/assets.html' on standard ports, ':8083/ui/assets.html' direct).
suite-shell.js relay generalized: accepts its three frames, broadcasts to
every frame except the sender (dir-* events now reach Assets too), suite-nav
handled from any frame. Split view stays Docket+Ledger (two panes).
suite.css: split rules keyed to .pane.show so the hidden third pane doesn't
join splits.
roles.js: ASSETS_CATALOG (9 ids) + third matrix section; applyPreset's
remove-filter now spares a_* ids exactly like l_* (else a Docket preset would
strip Assets grants — caught in design).

## Billing/term semantics for Builds 29/30 (locked with user)

* Charge = full cost_cents at each term start (purchase/renewal date), landing
  in the period containing that date. No amortization ever.
* recurring=true: at term end the term advances (term_started_on += term) and
  a new charge posts. recurring=false: the item lapses at term end → lapse
  ticket 60d before (warranty dates on assets behave the same).
* ledger.cost_lines will carry source_eid ('lic:<id>:<term_start>' /
  'ct:<id>:<term_start>' / 'asset:<id>') for idempotent posting.
* Retainer contracts (kind='retainer') post per their term like everything
  else; Ledger's dormant retainers display module stays off.
