-- ============================================================================
-- 0039_period_insert_guard.sql — close the INSERT hole in the immutability
-- ladder (audit CRIT-1).
--
-- ledger.guard_entry_immutability fires only on UPDATE OR DELETE (0001), and
-- ledger.ensure_period get-or-creates a period with no status check — so a
-- backdated POST of time whose started_at falls inside an already
-- approved/exported month silently landed a NEW entry in the locked period,
-- changing live totals after the invoice was cut. Worse, the entry was then
-- permanently stuck: every UPDATE (edit, void, timesheet approval) hits the
-- 'entry belongs to a % period — immutable' guard. Backdating a few days past
-- month-close is normal MSP use, so this is a data-corrupting production path.
--
-- This migration:
--   1) adds a BEFORE INSERT guard that refuses time landing in a non-open
--      period. Trigger names order the BEFORE INSERT chain alphabetically:
--      assign_period (0003, resolves period_id) → guard_insert_period (this)
--      → guard_task (0001) — the guard sees the resolved period_id.
--      SECURITY DEFINER with the pinned search_path, same reasoning as
--      0006/0012/0031: desk_api holds no grants on ledger.billing_periods,
--      and the trigger body must read bp.status regardless of caller.
--   2) re-homes any already-stuck rows: live entries that landed AFTER their
--      period closed (created_at past approved_at, or past exported_at for
--      exported periods) move to an open period — created_at's period when
--      open, else the current one — preserving the true work span. Entries
--      created between approve and export are left alone: the export payload
--      is computed at export time, so those rode into the invoice and moving
--      them would bill the hours twice. guard_immutable is disabled for the
--      surgical UPDATE only (owner-level, one-time, 0031 precedent).
-- Transactional + idempotent (build-8b rules): re-running finds no stuck rows
-- and the trigger drops-and-re-adds.
-- ============================================================================
BEGIN;

-- 1) the INSERT rung of the immutability ladder
CREATE OR REPLACE FUNCTION ledger.guard_entry_insert()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ledger, shared, pg_temp AS $$
DECLARE pstatus text; pkey text;
BEGIN
  -- FOR SHARE closes the race with a concurrent approve: an in-flight
  -- approve's row UPDATE makes this wait and re-read the new status; an
  -- in-flight insert's share lock makes the approve wait until the entry
  -- is committed and countable. Inserts share the lock among themselves.
  SELECT bp.status, bp.period_key INTO pstatus, pkey
    FROM ledger.billing_periods bp WHERE bp.id = NEW.period_id
    FOR SHARE OF bp;
  IF pstatus IN ('approved','exported') THEN
    RAISE EXCEPTION 'period % is % — cannot add time to a closed billing period; date the span in the current period',
      pkey, pstatus;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS guard_insert_period ON ledger.time_entries;
CREATE TRIGGER guard_insert_period BEFORE INSERT ON ledger.time_entries
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_entry_insert();

-- 2) free the rows the hole already stranded (none expected on most installs)
ALTER TABLE ledger.time_entries DISABLE TRIGGER guard_immutable;

DO $do$
DECLARE r record; tgt uuid; tstatus text; tkey text; n integer := 0;
BEGIN
  FOR r IN
    SELECT e.id, e.client_id, e.created_at, bp.period_key, bp.status
      FROM ledger.time_entries e
      JOIN ledger.billing_periods bp ON bp.id = e.period_id
     WHERE e.status <> 'void'
       AND (   (bp.status = 'approved' AND e.created_at > bp.approved_at)
            OR (bp.status = 'exported' AND e.created_at > bp.exported_at))
  LOOP
    tgt := ledger.ensure_period(r.client_id, r.created_at);
    SELECT bp.status, bp.period_key INTO tstatus, tkey
      FROM ledger.billing_periods bp WHERE bp.id = tgt;
    IF tstatus <> 'open' THEN
      tgt := ledger.ensure_period(r.client_id, now());
      SELECT bp.status, bp.period_key INTO tstatus, tkey
        FROM ledger.billing_periods bp WHERE bp.id = tgt;
    END IF;
    IF tstatus <> 'open' THEN
      RAISE EXCEPTION 'stuck entry % has no open period to re-home into — resolve by hand before applying 0039', r.id;
    END IF;
    UPDATE ledger.time_entries SET period_id = tgt WHERE id = r.id;
    INSERT INTO audit.events (app, action, entity, detail)
    VALUES ('ledger', 'Entry re-homed from closed period', 'entry:' || r.id,
            r.period_key || ' (' || r.status || ') → ' || tkey ||
            ' — landed after close through the pre-0039 INSERT hole; span preserved, bills in the open period');
    n := n + 1;
  END LOOP;
  IF n > 0 THEN
    RAISE NOTICE '0039: re-homed % stranded entr% out of closed periods',
      n, CASE WHEN n = 1 THEN 'y' ELSE 'ies' END;
  END IF;
END $do$;

ALTER TABLE ledger.time_entries ENABLE TRIGGER guard_immutable;

COMMIT;
