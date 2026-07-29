-- ============================================================================
-- 0010_client_profile.sql — the client modal carries more than the schema
-- stored (industry, website, address, timezone, "customer since", notes).
-- Rather than let those fields silently revert on hydrate, they live in one
-- jsonb profile column: display-only directory data, no invariants, no joins
-- — billing_cycle/billable_default/domains stay first-class columns because
-- Ledger and routing depend on them.
-- ============================================================================
BEGIN;

ALTER TABLE shared.clients
  ADD COLUMN profile jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
