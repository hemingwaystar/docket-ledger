-- ============================================================================
-- 0009_reclient.sql — moving a ticket to another client.
--
-- 1) ledger.reclient_ticket_entries(ticket, new_client): when a ticket is
--    re-homed, its still-open time entries follow (client_id + re-derived
--    period via ledger.ensure_period). Anything manager-approved or sitting
--    in an approved/exported period stays where it was billed — the
--    immutability guard would refuse anyway; we simply don't ask.
--    SECURITY DEFINER for the same reason as 0006: desk_api rightly has no
--    grants on ledger.billing_periods, and the guard trigger reads them.
--
-- 2) GRANT DELETE ON desk.ticket_tags to desk_api. The tags endpoint has
--    always issued DELETE for tag removal (tags are labels, not business
--    records — additions/removals are audited); the grant was never made,
--    so the first tag removal in production would have been refused
--    (least-privilege catching an unprovisioned path — bugs #5/#6 class).
--    This is the second documented DELETE exception after shared.sessions.
-- ============================================================================
BEGIN;

CREATE FUNCTION ledger.reclient_ticket_entries(p_ticket bigint, p_new_client uuid)
RETURNS TABLE (moved integer, kept integer)
SECURITY DEFINER SET search_path = ledger, shared, pg_temp
LANGUAGE plpgsql AS $$
DECLARE n_moved integer; n_kept integer;
BEGIN
  UPDATE ledger.time_entries e
     SET client_id = p_new_client,
         period_id = ledger.ensure_period(p_new_client, e.started_at)
   WHERE e.ticket_id = p_ticket
     AND e.client_id <> p_new_client
     AND e.ts_approved_at IS NULL
     AND (e.period_id IS NULL OR EXISTS
           (SELECT 1 FROM ledger.billing_periods bp
             WHERE bp.id = e.period_id AND bp.status = 'open'));
  GET DIAGNOSTICS n_moved = ROW_COUNT;
  SELECT count(*) INTO n_kept FROM ledger.time_entries e
   WHERE e.ticket_id = p_ticket AND e.client_id <> p_new_client;
  RETURN QUERY SELECT n_moved, n_kept;
END $$;

GRANT EXECUTE ON FUNCTION ledger.reclient_ticket_entries(bigint, uuid) TO desk_api;

GRANT DELETE ON desk.ticket_tags TO desk_api;

COMMIT;
