-- ============================================================================
-- 0038_client_billable_default.sql — the "Billable by default" checkbox
-- becomes real (Build 27b; user decision 2026-08-20).
--
-- WHY THIS EXISTS: shared.clients.billable_default has been stored + audited
-- since 0001 and surfaced on the Ledger client card since build 9's rework —
-- but NOTHING ever consumed it: ledger.priced() decided billability from
-- sentinel → client+type override → dated type flag → type base only. The
-- checkbox promised "new time bills" and delivered nothing.
--
-- THE WIRING (no new table): ledger.client_rates' client-WIDE lane
-- (activity_type_id IS NULL) has carried an effective-dated `billable`
-- column since 0001 that priced() never read. The checkbox now writes a
-- dated wide row (admin.py PATCH does this from today on; this migration
-- seeds rows for clients already unticked), and priced() gains EXACTLY ONE
-- rung with VETO-ONLY semantics:
--
--   billable = NOT sentinel AND COALESCE(
--       client+type override (dated)          -- the card's per-type toggles still win
--     , CASE WHEN client-wide flag (dated) = false THEN false END
--                                             -- unticked vetoes; ticked/absent falls
--                                             -- through (re-ticking must NEVER make
--                                             -- Internal/Cancelled types billable)
--     , dated type flag , type base)
--
-- 0018's law holds by construction: every lookup is valid_from <=
-- entry.started_at::date, so flipping the checkbox today never re-prices
-- yesterday's time, and locked periods never change.
--
-- SEED SAFETY: the wide lane's rate reader takes the LATEST row's rate_cents
-- even when NULL (the documented dated-unset convention), so the seed rows
-- CARRY THE CURRENT WIDE RATE FORWARD — seeding billable must not silently
-- reset a client-wide rate override. Same-day rows collapse via the partial
-- unique index, updating only billable.
--
-- Function re-issue rule (bug row 48): priced() is LANGUAGE sql STABLE with
-- no other attributes (0001/0018/0029 all agree) — restated verbatim.
-- Transactional + idempotent (build-8b rules).
-- ============================================================================
BEGIN;

-- ---- 1. seed dated wide-lane rows for clients already unticked -------------
-- (includes the intake sentinel, seeded false in 0002 — unassigned-intake
-- time should never invoice anyway; entries re-price when reclient'ed)
INSERT INTO ledger.client_rates (client_id, activity_type_id, valid_from, rate_cents, billable)
SELECT c.id, NULL, current_date,
       (SELECT r.rate_cents FROM ledger.client_rates r
         WHERE r.client_id = c.id AND r.activity_type_id IS NULL
           AND r.valid_from <= current_date
         ORDER BY r.valid_from DESC LIMIT 1),   -- carry the wide rate forward
       false
  FROM shared.clients c
 WHERE c.billable_default = false
ON CONFLICT (client_id, valid_from) WHERE activity_type_id IS NULL
  DO UPDATE SET billable = EXCLUDED.billable;   -- same-day row: touch billable only

-- ---- 2. desk-api seeds the veto row for clients BORN unticked ---------------
-- (Directory's POST /clients accepts billable_default; post-0038 the lane is
-- pricing truth, so creation must write it too. INSERT only — a brand-new
-- client has no same-day wide row to conflict with; explicit per 0011's
-- cross-role grant-audit doctrine.)
GRANT INSERT ON ledger.client_rates TO desk_api;

-- ---- 3. priced() — 0029's body verbatim plus the one veto rung --------------
CREATE OR REPLACE FUNCTION ledger.priced(entry ledger.time_entries)
RETURNS TABLE (rate_cents integer, amount_cents integer, billable boolean, covered_by_project_flat boolean)
LANGUAGE sql STABLE AS $$
  WITH proj AS (
    SELECT p.billing_model, p.status,
           t.billing_mode AS task_mode, t.rate_cents AS task_rate
    FROM desk.projects p
    LEFT JOIN desk.project_tasks t ON t.id = entry.task_id
    WHERE p.ticket_id = entry.ticket_id AND p.status = 'approved'
  ),
  ladder AS (
    SELECT COALESCE(
      (SELECT task_rate FROM proj WHERE task_mode = 'hourly' AND task_rate IS NOT NULL),
      (SELECT r.rate_cents FROM ledger.ticket_rates r
        WHERE r.ticket_id = entry.ticket_id AND r.valid_from <= entry.started_at::date
        ORDER BY r.valid_from DESC LIMIT 1),
      (SELECT r.rate_cents FROM ledger.client_rates r
        WHERE r.client_id = entry.client_id AND r.activity_type_id = entry.activity_type_id
          AND r.valid_from <= entry.started_at::date ORDER BY r.valid_from DESC LIMIT 1),
      (SELECT r.rate_cents FROM ledger.client_rates r
        WHERE r.client_id = entry.client_id AND r.activity_type_id IS NULL
          AND r.valid_from <= entry.started_at::date ORDER BY r.valid_from DESC LIMIT 1),
      -- 0029: global default, only while the client's switch was on
      -- and the type not toggled off, all as-of the entry's own date
      (SELECT r.rate_cents FROM ledger.default_rates r
        WHERE r.activity_type_id = entry.activity_type_id
          AND r.valid_from <= entry.started_at::date
          AND COALESCE(
                (SELECT f.enabled FROM ledger.client_default_rate_optin f
                  WHERE f.client_id = entry.client_id AND f.activity_type_id IS NULL
                    AND f.valid_from <= entry.started_at::date
                  ORDER BY f.valid_from DESC LIMIT 1), false)
          AND COALESCE(
                (SELECT f.enabled FROM ledger.client_default_rate_optin f
                  WHERE f.client_id = entry.client_id AND f.activity_type_id = entry.activity_type_id
                    AND f.valid_from <= entry.started_at::date
                  ORDER BY f.valid_from DESC LIMIT 1), true)
        ORDER BY r.valid_from DESC LIMIT 1),
      (SELECT r.rate_cents FROM ledger.activity_type_rates r
        WHERE r.activity_type_id = entry.activity_type_id
          AND r.valid_from <= entry.started_at::date ORDER BY r.valid_from DESC LIMIT 1),
      0) AS rate_cents
  ),
  flags AS (
    SELECT
      EXISTS (SELECT 1 FROM proj WHERE billing_model = 'project_flat'
              UNION ALL SELECT 1 FROM proj WHERE task_mode = 'flat') AS covered,
      (SELECT NOT at.is_sentinel AND COALESCE(
          (SELECT cr.billable FROM ledger.client_rates cr
            WHERE cr.client_id = entry.client_id AND cr.activity_type_id = entry.activity_type_id
              AND cr.billable IS NOT NULL AND cr.valid_from <= entry.started_at::date
            ORDER BY cr.valid_from DESC LIMIT 1),
          -- NEW (0038): the client-wide "billable by default" flag, dated —
          -- VETO ONLY: false forces non-billable, true/absent falls through
          -- so the type's own flag keeps deciding
          CASE WHEN (SELECT cw.billable FROM ledger.client_rates cw
                      WHERE cw.client_id = entry.client_id AND cw.activity_type_id IS NULL
                        AND cw.billable IS NOT NULL AND cw.valid_from <= entry.started_at::date
                      ORDER BY cw.valid_from DESC LIMIT 1) = false
               THEN false END,
          (SELECT tr.billable FROM ledger.activity_type_rates tr
            WHERE tr.activity_type_id = entry.activity_type_id
              AND tr.billable IS NOT NULL AND tr.valid_from <= entry.started_at::date
            ORDER BY tr.valid_from DESC LIMIT 1),
          at.billable)
        FROM ledger.activity_types at WHERE at.id = entry.activity_type_id) AS type_billable
  )
  SELECT
    l.rate_cents,
    CASE WHEN entry.status = 'void' OR f.covered OR NOT f.type_billable THEN 0
         ELSE round(entry.hours * l.rate_cents)::integer END,
    f.type_billable AND NOT f.covered,
    f.covered
  FROM ladder l, flags f;
$$;

INSERT INTO audit.events (app, action, detail)
VALUES ('system', 'Migration 0038',
        'client billable_default wired into ledger.priced() as a dated client-wide veto rung; unticked clients seeded into the wide client_rates lane');

COMMIT;
