-- ============================================================================
-- 0006 — ledger.ensure_period becomes SECURITY DEFINER.
-- The assign_period trigger runs as the CALLING role; desk-api (logging time
-- from tickets) rightly has no direct grants on ledger.billing_periods, so
-- period get-or-create must carry the definer's privileges instead of the
-- caller's. This keeps the segmentation: desk_api still cannot read or write
-- periods itself — only mint one implicitly by logging time.
-- ============================================================================
BEGIN;
ALTER FUNCTION ledger.ensure_period(uuid, timestamptz) SECURITY DEFINER;
ALTER FUNCTION ledger.ensure_period(uuid, timestamptz) SET search_path = ledger, shared, pg_temp;
COMMIT;
