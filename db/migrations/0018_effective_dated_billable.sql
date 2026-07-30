-- ============================================================================
-- 0018_effective_dated_billable.sql — billing changes never re-price history.
--
-- Rates were already effective-dated on every rung and priced() resolves
-- them as-of each entry's own date — so rate changes only ever touched
-- future time. The one hole: the TYPE-level billable flag was a plain
-- column, so flipping it re-priced all history. billable now rides on
-- activity_type_rates (NULL = rate-only row) and priced() resolves it
-- as-of date like everything else, falling back to the column (which stays
-- as the "current" value the UI displays). The API anchors the OLD value
-- at epoch on the first flip so pre-change entries keep pre-change
-- semantics. Function body below is 0001's verbatim, plus exactly that
-- one lookup — reset-to-inherit rows (NULL rate) still shadow older rows
-- so COALESCE falls through, which is what makes "reset" effective-dated.
-- ============================================================================
BEGIN;

ALTER TABLE ledger.activity_type_rates ADD COLUMN billable boolean;

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

COMMIT;
