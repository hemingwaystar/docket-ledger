-- ============================================================================
-- 0031_era_guard_1930_cleanup.sql — bug #27's residue, removed for good.
--
-- A pre-guard mistyped year minted a July-1930 time entry AND its billing
-- period. The documented cleanup (void the entry) removed the ghost sheet
-- and the bootstrap emission, but the Billing Periods history derives period
-- keys from ALL entries including void ones — so "July 1930 · Open · 0
-- entries +1 void" kept rendering (UI fix ships with this build), and the
-- garbage rows themselves were still in the database. This migration:
--   0) refuses to run if any pre-2000 entry is live, manager-approved, or in
--      a non-open period (none is expected — fail loudly, roll back clean);
--   1) re-dates each pre-2000 entry to the moment it was actually recorded
--      (created_at), preserving its duration (hours is GENERATED and
--      recomputes; the entry is void, so it prices $0 either way) and
--      re-homing period_id via ledger.ensure_period — assign_period only
--      fires on INSERT, so the UPDATE must set it explicitly;
--   2) deletes the now-empty pre-2000 period shells. Owner-level, one-time:
--      no role gains DELETE (grants untouched; the no-DELETE doctrine stands),
--      billing_periods has no delete-guard trigger, and the WHERE proves the
--      shells are empty and never exported;
--   3) adds permanent era CHECKs on both tables so no direct INSERT can ever
--      recreate the class;
--   4) re-issues ledger.ensure_period (0003's body verbatim) with a leading
--      era guard mirroring the API's _sane_span window — the DB now refuses
--      to mint out-of-era periods no matter which caller asks. OR REPLACE
--      preserves 0003's EXECUTE grants — but NOT 0006's attributes, so the
--      declaration below restates SECURITY DEFINER + the pinned search_path.
--      ensure_period has been SECURITY DEFINER since 0006 (desk_api holds no
--      grants on billing_periods; the assign_period trigger runs as the
--      caller) and MUST stay so on every future re-issue.
-- Transactional + idempotent (build-8b rules): re-running finds no pre-2000
-- rows and updates/deletes nothing; the CHECKs drop-and-re-add; ensure_period
-- is CREATE OR REPLACE.
-- ============================================================================
BEGIN;

-- 0) tripwire: this file expects only voided, unapproved, open-period garbage
DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM ledger.time_entries e
   WHERE e.started_at < '2000-01-01 00:00:00+00'::timestamptz
     AND (e.status <> 'void'
          OR e.ts_approved_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM ledger.billing_periods bp
                      WHERE bp.id = e.period_id AND bp.status <> 'open'));
  IF n > 0 THEN
    RAISE EXCEPTION 'pre-2000 cleanup: % entr% live/approved/locked — resolve by hand before applying 0031',
      n, CASE WHEN n = 1 THEN 'y is' ELSE 'ies are' END;
  END IF;
  -- and the shell-side escape class: a pre-2000 period that is non-open or
  -- exported would dodge step 2's DELETE and abort at step 3's ADD CONSTRAINT
  -- with a bare check-violation — catch it here with the guided message instead
  SELECT count(*) INTO n
    FROM ledger.billing_periods bp
   WHERE left(bp.period_key, 4) < '2000'
     AND (bp.status <> 'open'
          OR EXISTS (SELECT 1 FROM ledger.odoo_exports x WHERE x.period_id = bp.id));
  IF n > 0 THEN
    RAISE EXCEPTION 'pre-2000 cleanup: % period shell% non-open or exported — resolve by hand before applying 0031',
      n, CASE WHEN n = 1 THEN ' is' ELSE 's are' END;
  END IF;
END $do$;

-- 1) re-date the voided garbage to its created_at moment, duration preserved
WITH moved AS (
  UPDATE ledger.time_entries e
     SET started_at = e.created_at,
         ended_at   = e.created_at + (e.ended_at - e.started_at),
         period_id  = ledger.ensure_period(e.client_id, e.created_at)
   WHERE e.started_at < '2000-01-01 00:00:00+00'::timestamptz
  RETURNING e.id
)
INSERT INTO audit.events (app, action, entity, detail)
SELECT 'ledger', 'Entry span corrected', 'entry:' || m.id,
       'bug #27 residue — pre-2000 span re-dated to its created_at by migration 0031 (entry is void; prices $0 either way)'
  FROM moved m;

-- 2) delete the emptied pre-2000 period shells (owner-level, provably empty)
WITH gone AS (
  DELETE FROM ledger.billing_periods bp
   WHERE left(bp.period_key, 4) < '2000'
     AND bp.status = 'open'
     AND NOT EXISTS (SELECT 1 FROM ledger.time_entries e  WHERE e.period_id = bp.id)
     AND NOT EXISTS (SELECT 1 FROM ledger.odoo_exports x WHERE x.period_id = bp.id)
  RETURNING bp.id, bp.period_key
)
INSERT INTO audit.events (app, action, entity, detail)
SELECT 'ledger', 'Ghost period removed', 'period:' || g.id,
       g.period_key || ' — empty pre-2000 shell deleted by migration 0031; era guard prevents recurrence'
  FROM gone g;

-- 3) permanent backstops (validate all rows now — cleanup above makes it pass)
ALTER TABLE ledger.time_entries
  DROP CONSTRAINT IF EXISTS time_entries_modern_era;
ALTER TABLE ledger.time_entries
  ADD CONSTRAINT time_entries_modern_era
  CHECK (started_at >= '2000-01-01 00:00:00+00'::timestamptz);
ALTER TABLE ledger.billing_periods
  DROP CONSTRAINT IF EXISTS billing_periods_modern_era;
ALTER TABLE ledger.billing_periods
  ADD CONSTRAINT billing_periods_modern_era
  CHECK (left(period_key, 4) >= '2000');

-- 4) the sole period minter refuses out-of-era dates (0003 body + guard)
CREATE OR REPLACE FUNCTION ledger.ensure_period(p_client uuid, p_at timestamptz)
RETURNS uuid LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ledger, shared, pg_temp AS $$
DECLARE k text; pid uuid;
BEGIN
  IF p_at < '2000-01-01 00:00:00+00'::timestamptz
     OR p_at > now() + interval '400 days' THEN
    RAISE EXCEPTION 'refusing to mint a billing period at % — check the year', p_at::date;
  END IF;
  k := ledger.period_key_for(p_client, p_at);
  IF k IS NULL THEN RAISE EXCEPTION 'unknown client %', p_client; END IF;
  INSERT INTO ledger.billing_periods (client_id, period_key)
  VALUES (p_client, k)
  ON CONFLICT (client_id, period_key) DO NOTHING;
  SELECT id INTO pid FROM ledger.billing_periods
   WHERE client_id = p_client AND period_key = k;
  RETURN pid;
END $$;

COMMIT;
