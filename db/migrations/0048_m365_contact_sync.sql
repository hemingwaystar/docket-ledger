-- ============================================================================
-- 0048_m365_contact_sync.sql — sync each client's Microsoft 365 users into
-- shared.contacts (mail-worker, daily + "Sync now").
--   * shared.m365_tenants: one row per linked client — which tenant, whether
--     the sync is on, and the last run's outcome. Kept OFF shared.clients on
--     purpose: the touch trigger bumps clients.version on every UPDATE, and a
--     status write per sync must not churn the client record.
--   * shared.contacts.entra_oid: the user's immutable Entra object id — the
--     match key, so a renamed / re-addressed user updates in place instead of
--     duplicating. Object ids are GUIDs, unique across tenants.
--   * shared.contacts.source: manual | csv | mail | m365 — manual and CSV
--     contacts are shown as such and the sync never deactivates them.
--   * mail_worker gets exactly the writes the sync makes: the synced contact
--     columns (never vip/pref/notes/source — Docket-only) and the status
--     columns on m365_tenants. No DELETE anywhere: offboarded users are
--     deactivated, so their ticket history stays intact.
-- Transactional + idempotent (build-8b rules). Runs as postgres (superuser).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS shared.m365_tenants (
  client_id       uuid PRIMARY KEY REFERENCES shared.clients(id),
  tenant_id       text NOT NULL UNIQUE
                  CHECK (tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  enabled         boolean NOT NULL DEFAULT true,
  sync_requested  boolean NOT NULL DEFAULT true,   -- first run happens on the next pass
  next_due_at     timestamptz,
  last_attempt_at timestamptz,
  last_ok_at      timestamptz,
  last_status     text NOT NULL DEFAULT '',
  last_counts     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text NOT NULL DEFAULT shared.current_actor()
);

ALTER TABLE shared.contacts
  ADD COLUMN IF NOT EXISTS entra_oid text,
  ADD COLUMN IF NOT EXISTS synced_at timestamptz,
  -- where the contact came from. manual/csv are PROTECTED: the sync may link
  -- and fill them, but never deactivates or reactivates them (user's call).
  -- Default 'manual' so any insert path that forgets to say is protected.
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'csv', 'mail', 'm365')),
  -- true only when the SYNC deactivated the contact — the one case it may
  -- reactivate (rehire / licence restored). A tech's own deactivation
  -- (PATCH active) clears it, so the sync never undoes a human decision.
  ADD COLUMN IF NOT EXISTS sync_deactivated boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_entra_oid_key
  ON shared.contacts (entra_oid) WHERE entra_oid IS NOT NULL;

-- backfill: the routing ladder's domain-match contacts are recorded in the
-- audit log as 'Contact auto-created'. Everything else (UI + CSV import —
-- indistinguishable before this migration) stays 'manual', i.e. protected.
UPDATE shared.contacts c SET source = 'mail'
 WHERE c.source = 'manual'
   AND EXISTS (SELECT 1 FROM audit.events e
                WHERE e.entity = 'contact:' || c.id::text
                  AND e.action = 'Contact auto-created');

-- desk_api: default privileges (0005) already give S/I/U on new shared tables;
-- restated so the grant is visible next to the table.
GRANT SELECT, INSERT, UPDATE ON shared.m365_tenants TO desk_api;
GRANT SELECT ON shared.m365_tenants TO ledger_api, mail_worker;
GRANT UPDATE (sync_requested, next_due_at, last_attempt_at, last_ok_at,
              last_status, last_counts)
  ON shared.m365_tenants TO mail_worker;
GRANT UPDATE (name, email, title, department, phone, mobile, fax, active,
              entra_oid, synced_at, sync_deactivated)
  ON shared.contacts TO mail_worker;

COMMIT;
