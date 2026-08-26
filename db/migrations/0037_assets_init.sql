-- ============================================================================
-- 0037_assets_init.sql — Assets, the suite's third app (Build 27 foundation).
--
-- WHY THIS EXISTS: the ITAM app (hardware/CI inventory, software & licenses,
-- vendor contracts & warranties) approved from the 2026-08-05 prototype.
-- Design of record: docs/BUILD27-DESIGN.md. This migration lays ONLY the
-- foundation: schema + tables, the assets_api runtime role, the a_* permission
-- catalog, and two CHECK widenings that hard-block a third app today.
--
--   * shared.permissions.app CHECKed (app IN ('desk','ledger')) — 0001:96 —
--     and audit.events.app CHECKed to a fixed five — 0001:53. Both re-issued
--     with 'assets' or no assets permission row / audit row can ever land.
--   * Terms are TYPED, not vendor presets (user decision 2026-08-20):
--     term_months 1..120 (monthly=1, 3-yr=36...) + recurring flag. cost_cents
--     LICENCES: per SEAT per term as of Build 27e (this file predates that
--     — a Build 29 implementer must post unit_cost × seats). CONTRACTS: per
--     TERM, billed up front at term start — never amortized. Build 29
--     posts these to ledger.cost_lines; Build 30 raises lapse tickets 60d
--     before non-recurring terms / warranties end (config seeded here).
--   * assets.asset_events is the per-entity attributed event feed — Docket's
--     kind='sys' articles are ticket-bound, so Assets carries its own table.
--     Dual-audit doctrine (build 22) holds: every ENTITY write (asset /
--     licence / contract) writes BOTH an asset_events row AND audit.events
--     app='assets'; config writes audit to audit.events only (ledger's
--     put_config precedent — app_config is not an inventory entity).
--   * assets_api mirrors ledger_api's session posture: SELECT-only on
--     shared.sessions (desk-api mints/revokes; this app only validates).
--     DELETE granted NOWHERE except assets.contract_assets — a replace-style
--     membership link table (0011 doctrine, 0032's assignees precedent).
--
-- Transactional + idempotent (build-8b rules): IF NOT EXISTS / OR REPLACE /
-- ON CONFLICT DO NOTHING throughout; the role and constraint re-issues are
-- DO-block guarded. GRANTs restated explicitly for legibility even where
-- defaults would cover them (0005 note: defaults enumerate only the original
-- three roles — a new role gets NOTHING automatically).
-- ============================================================================
BEGIN;

-- ---- 1. CHECK widenings (the two hard blockers) ----------------------------
-- Each table carries exactly one CHECK (its app column); drop whatever it is
-- named and re-add with 'assets'. Re-running drops ours and re-adds — clean.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'shared.permissions'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE shared.permissions DROP CONSTRAINT %I', c.conname);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'audit.events'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE audit.events DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE shared.permissions
  ADD CONSTRAINT permissions_app_check CHECK (app IN ('desk','ledger','assets'));
ALTER TABLE audit.events
  ADD CONSTRAINT events_app_check CHECK (app IN ('desk','ledger','assets','mail','auth','system'));

-- ---- 2. schema + tables -----------------------------------------------------
CREATE SCHEMA IF NOT EXISTS assets;

CREATE TABLE IF NOT EXISTS assets.assets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_tag         text NOT NULL UNIQUE,          -- 'LT-0442' — the CI handle tickets will name (Build 28)
  name           text NOT NULL,                 -- 'Dell Latitude 7440'
  atype          text NOT NULL CHECK (atype IN
                   ('Laptop','Desktop','Server','Network','Firewall','Mobile','Printer','Peripheral','Other')),
  client_id      uuid NOT NULL REFERENCES shared.clients(id),
  assigned_to    text NOT NULL DEFAULT '',      -- free text: person, rack, room
  status         text NOT NULL DEFAULT 'inuse' CHECK (status IN ('inuse','stock','repair','retired')),
  serial         text NOT NULL DEFAULT '',
  vendor         text NOT NULL DEFAULT '',
  purchased_on   date CHECK (purchased_on IS NULL OR (purchased_on > '2000-01-01' AND purchased_on < '2100-01-01')),
  warranty_until date CHECK (warranty_until IS NULL OR (warranty_until > '2000-01-01' AND warranty_until < '2100-01-01')),
  cost_cents     integer CHECK (cost_cents IS NULL OR cost_cents >= 0),   -- integer cents everywhere
  note           text NOT NULL DEFAULT '',
  archived_at    timestamptz,                   -- soft-remove; 'retired' is a lifecycle status, archive hides
  version        integer NOT NULL DEFAULT 1,    -- optimistic lock (shared.touch_row)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_client_idx ON assets.assets (client_id);
CREATE INDEX IF NOT EXISTS assets_status_idx ON assets.assets (status);
CREATE OR REPLACE TRIGGER touch BEFORE UPDATE ON assets.assets
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

CREATE TABLE IF NOT EXISTS assets.licenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product         text NOT NULL,                -- 'Microsoft 365 Business Premium'
  vendor          text NOT NULL DEFAULT '',
  client_id       uuid REFERENCES shared.clients(id),   -- NULL = MSP-wide pool
  seats_total     integer NOT NULL DEFAULT 1 CHECK (seats_total >= 1),
  seats_used      integer NOT NULL DEFAULT 0 CHECK (seats_used >= 0),  -- may exceed total (over-allocation is a true-up flag, not an error)
  term_months     integer NOT NULL DEFAULT 12 CHECK (term_months BETWEEN 1 AND 120),
  recurring       boolean NOT NULL DEFAULT false,       -- auto-renews at term end (Build 30 advances it)
  term_started_on date NOT NULL DEFAULT current_date
                    CHECK (term_started_on > '2000-01-01' AND term_started_on < '2100-01-01'),
  cost_cents      integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),  -- per SEAT per term as of 27e (was per-term when written)
  note            text NOT NULL DEFAULT '',
  archived_at     timestamptz,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS licenses_client_idx ON assets.licenses (client_id);
CREATE OR REPLACE TRIGGER touch BEFORE UPDATE ON assets.licenses
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

CREATE TABLE IF NOT EXISTS assets.contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor          text NOT NULL,                -- agreement name: 'Dell ProSupport Plus'
  kind            text NOT NULL DEFAULT 'support' CHECK (kind IN ('support','warranty','retainer','other')),
  client_id       uuid NOT NULL REFERENCES shared.clients(id),
  scope_note      text NOT NULL DEFAULT '',     -- human coverage note; hard links via contract_assets
  term_months     integer NOT NULL DEFAULT 12 CHECK (term_months BETWEEN 1 AND 120),
  recurring       boolean NOT NULL DEFAULT false,
  term_started_on date NOT NULL DEFAULT current_date
                    CHECK (term_started_on > '2000-01-01' AND term_started_on < '2100-01-01'),
  cost_cents      integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),  -- per TERM, billed up front
  archived_at     timestamptz,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contracts_client_idx ON assets.contracts (client_id);
CREATE OR REPLACE TRIGGER touch BEFORE UPDATE ON assets.contracts
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

-- membership join: which CIs a contract covers — full-replace semantics like
-- desk.ticket_assignees (0032); DELETE granted (documented 0011-style below)
CREATE TABLE IF NOT EXISTS assets.contract_assets (
  contract_id uuid NOT NULL REFERENCES assets.contracts(id) ON DELETE CASCADE,
  asset_id    uuid NOT NULL REFERENCES assets.assets(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  added_by    text NOT NULL DEFAULT '',
  PRIMARY KEY (contract_id, asset_id)
);
CREATE INDEX IF NOT EXISTS contract_assets_asset_idx ON assets.contract_assets (asset_id);

-- per-entity attributed event feed (the ticket Audit block's sibling)
CREATE TABLE IF NOT EXISTS assets.asset_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('asset','license','contract')),
  entity_id  uuid NOT NULL,
  author     text NOT NULL,                     -- display name at write time
  author_id  uuid REFERENCES shared.agents(id), -- NULL for PATs/automation
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_events_entity_idx ON assets.asset_events (kind, entity_id);

-- ---- 3. runtime role + grants ----------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'assets_api') THEN
    CREATE ROLE assets_api NOINHERIT LOGIN;     -- password set by migrate.sh from the mounted secret
  END IF;
END $$;

GRANT USAGE ON SCHEMA shared, assets, audit TO assets_api;
-- read the whole shared directory (sessions/agents for auth, clients for FKs,
-- app_config for its settings key) — ledger_api's exact read posture
GRANT SELECT ON ALL TABLES IN SCHEMA shared TO assets_api;
GRANT UPDATE (last_used_at) ON shared.api_tokens TO assets_api;   -- PAT stamping (0001:761 precedent)
GRANT INSERT, UPDATE ON shared.app_config TO assets_api;          -- PUT /api/config/assets (0016 precedent)
-- per-table on purpose: asset_events is the append-only half of the dual
-- audit (INSERT+SELECT only, mirroring audit.events' posture 0001:774);
-- contract_assets is replace-style membership (INSERT+DELETE, no UPDATE,
-- 0011 doctrine)
GRANT SELECT, INSERT, UPDATE ON assets.assets, assets.licenses, assets.contracts TO assets_api;
GRANT SELECT, INSERT, DELETE ON assets.contract_assets TO assets_api;
GRANT SELECT, INSERT ON assets.asset_events TO assets_api;
GRANT INSERT, SELECT ON audit.events TO assets_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA assets, audit, shared TO assets_api;

-- future tables follow the same shape without per-migration grants (0005 pattern;
-- defaults attach to the postgres role that runs migrate)
ALTER DEFAULT PRIVILEGES IN SCHEMA assets GRANT SELECT, INSERT, UPDATE ON TABLES TO assets_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA assets GRANT USAGE ON SEQUENCES TO assets_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT ON TABLES TO assets_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit  GRANT SELECT, INSERT ON TABLES TO assets_api;

-- ---- 4. permission catalog + core-role presets -------------------------------
-- a_-prefixed (ledger's l_ precedent). Admin gets ALL NINE explicitly — the
-- 0002 CROSS JOIN was a one-time seed; new permission rows are never
-- auto-granted (recon finding).
INSERT INTO shared.permissions (id, app, grp, label) VALUES
  ('a_view',            'assets', 'Visibility', 'View the Assets app'),
  ('a_see_costs',       'assets', 'Visibility', 'See purchase & contract costs'),
  ('a_manage_assets',   'assets', 'Inventory',  'Add & edit assets'),
  ('a_manage_licenses', 'assets', 'Inventory',  'Manage software & licenses'),
  ('a_manage_contracts','assets', 'Inventory',  'Manage contracts & warranties'),
  ('a_post_charges',    'assets', 'Billing',    'Post charges to Ledger'),
  ('a_export_csv',      'assets', 'Admin',      'Export & copy CSV data'),
  ('a_view_audit',      'assets', 'Admin',      'View the Assets audit log'),
  ('a_manage_settings', 'assets', 'Admin',      'Manage Assets settings')
ON CONFLICT (id) DO NOTHING;

INSERT INTO shared.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM shared.roles r JOIN shared.permissions p ON p.app = 'assets'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;

INSERT INTO shared.role_permissions (role_id, permission_id)
SELECT r.id, unnest(ARRAY['a_view','a_see_costs','a_export_csv'])
FROM shared.roles r WHERE r.name = 'Dispatcher'
ON CONFLICT DO NOTHING;

INSERT INTO shared.role_permissions (role_id, permission_id)
SELECT r.id, unnest(ARRAY['a_view','a_manage_assets'])
FROM shared.roles r WHERE r.name = 'Technician'
ON CONFLICT DO NOTHING;

-- ---- 5. lapse-scan config (consumed by Build 30's worker pass; edited on the
--         Assets Settings page from day one) ----------------------------------
INSERT INTO shared.app_config (key, value) VALUES
  ('assets', '{"lapse_lead_days": 60, "lapse_group": "Alerts", "lapse_kinds": {"warranty": true, "license": true, "contract": true}}')
ON CONFLICT (key) DO NOTHING;

INSERT INTO audit.events (app, action, detail)
VALUES ('system', 'Migration 0037',
        'assets schema + assets_api role created; a_* permission catalog seeded; permissions/audit app CHECKs widened for ''assets''');

COMMIT;
