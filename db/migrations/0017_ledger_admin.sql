-- ============================================================================
-- 0017_ledger_admin.sql — the Ledger admin layer gets storage and grants.
--
-- 1) BUG #24 (latent since 0001): client_rates' PRIMARY KEY includes
--    activity_type_id, which forces it NOT NULL — the documented
--    "NULL = client-wide override" was never storable. Replaced with two
--    partial unique indexes so both row shapes exist and same-day edits
--    still collapse. ledger.priced() and the bootstrap already read the
--    NULL-type branch; it simply never had rows to find.
--
-- 2) ledger.client_access — the per-client visibility rules the prototype
--    always had (everyone / restricted techs / by group) get real storage.
--    Arrays, not link tables: this is display/scoping config, not a billing
--    invariant; revisit if server-side enforcement lands.
--
-- 3) Grants: ledger_api may set the two billing columns on clients (the
--    Docket clients page says "billing config lives in Ledger" — now true),
--    column-scoped so the directory stays desk-owned. desk_api gets DELETE
--    on role_permissions for the replace-style role editor (same class as
--    agent_groups/client_domains, 0011).
-- ============================================================================
BEGIN;

ALTER TABLE ledger.client_rates DROP CONSTRAINT client_rates_pkey;
CREATE UNIQUE INDEX client_rates_typed_key ON ledger.client_rates
  (client_id, valid_from, activity_type_id) WHERE activity_type_id IS NOT NULL;
CREATE UNIQUE INDEX client_rates_wide_key ON ledger.client_rates
  (client_id, valid_from) WHERE activity_type_id IS NULL;

CREATE TABLE ledger.client_access (
  client_id  uuid PRIMARY KEY REFERENCES shared.clients(id) ON DELETE CASCADE,
  mode       text NOT NULL DEFAULT 'all' CHECK (mode IN ('all','restricted','group')),
  tech_ids   uuid[] NOT NULL DEFAULT '{}',
  group_ids  uuid[] NOT NULL DEFAULT '{}',
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch BEFORE UPDATE ON ledger.client_access
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

GRANT UPDATE (billing_cycle, billable_default) ON shared.clients TO ledger_api;
GRANT DELETE ON shared.role_permissions TO desk_api;

COMMIT;
