-- ============================================================================
-- 0042_rehome_on_span_edit.sql — span edits re-home the entry's billing
-- period (audit). assign_period fires only on INSERT, so editing an entry's
-- started_at across a month/week boundary left period_id pointing at the OLD
-- period: totals counted it in one month while its span sat in another, and
-- the UI (which buckets by date) disagreed with every server period total.
--
-- BEFORE UPDATE, firing order (alphabetical): guard_immutable first (the OLD
-- period must be open for any edit at all), guard_task, then this. Only acts
-- when the CALLER left period_id untouched — migrations that set both fields
-- explicitly (0031/0039 style) are respected. The FOR SHARE + status check
-- mirror 0039's insert guard: a span can never move INTO a closed period.
-- SECURITY DEFINER + pinned search_path per the 0006/0012/0031/0039 rule —
-- desk_api holds no billing_periods grants. Idempotent (build-8b rules).
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION ledger.rehome_period()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ledger, shared, pg_temp AS $$
DECLARE pstatus text; pkey text;
BEGIN
  IF NEW.started_at IS DISTINCT FROM OLD.started_at
     AND NEW.period_id IS NOT DISTINCT FROM OLD.period_id THEN
    NEW.period_id := ledger.ensure_period(NEW.client_id, NEW.started_at);
    IF NEW.period_id IS DISTINCT FROM OLD.period_id THEN
      SELECT bp.status, bp.period_key INTO pstatus, pkey
        FROM ledger.billing_periods bp WHERE bp.id = NEW.period_id
        FOR SHARE OF bp;
      IF pstatus IN ('approved', 'exported') THEN
        RAISE EXCEPTION 'period % is % — cannot move time into a closed billing period',
          pkey, pstatus;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS rehome_period ON ledger.time_entries;
CREATE TRIGGER rehome_period BEFORE UPDATE ON ledger.time_entries
  FOR EACH ROW EXECUTE FUNCTION ledger.rehome_period();

COMMIT;
