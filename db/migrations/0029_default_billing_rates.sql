-- ============================================================================
-- 0029_default_billing_rates.sql — global default billing rates, opt-in per
-- client.
--
-- The prototype had "default billing rates"; live pricing has only per-client
-- rates plus the unconditional per-type base rate. This restores defaults as
-- an EXPLICIT, OPT-IN lane:
--   * ledger.default_rates — one global default rate per activity type,
--     effective-dated, integer cents, edited on Ledger Settings. A NULL
--     rate_cents row is a dated "unset": it shadows older rows so priced()'s
--     COALESCE falls through — the same reset convention 0018 documents for
--     client_rates.
--   * ledger.client_default_rate_optin — effective-dated flags. The
--     activity_type_id IS NULL row is the client's "use global default
--     rates" switch (absent/false = today's behavior, unchanged). A typed
--     row toggles ONE work type out of (enabled=false) or back into
--     (enabled=true) inheriting while the switch is on; absent = inherits.
--     Two-lane shape copies client_rates' 0017 partial-index pattern —
--     a PK is a NOT NULL in disguise (bug #24), so no PK over the nullable
--     column.
--   * priced() gains EXACTLY ONE rung, between the client-wide override and
--     the activity-type base rate:
--       client+type rate → client-wide rate
--         → (switch on as-of date AND type not toggled off as-of date)
--           global default rate as-of date
--         → activity-type base rate → 0/unbilled
--     Every lookup is valid_from <= entry.started_at::date, so flipping a
--     switch or changing a default NEVER re-prices history (0018's law) and
--     locked periods never change.
--
-- Grants: none needed — 0005's DEFAULT PRIVILEGES in schema ledger already
-- give ledger_api SELECT/INSERT/UPDATE on new ledger tables; ledger_api is
-- the only caller of ledger.priced() (verified against all three services),
-- and priced() runs with caller privileges. No cross-schema reader exists.
-- Transactional + idempotent (build-8b rules): IF NOT EXISTS on tables and
-- indexes, CREATE OR REPLACE on the function.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS ledger.default_rates (
  activity_type_id uuid NOT NULL REFERENCES ledger.activity_types(id) ON DELETE CASCADE,
  valid_from       date NOT NULL,
  rate_cents       integer CHECK (rate_cents IS NULL OR rate_cents >= 0),
  PRIMARY KEY (activity_type_id, valid_from)      -- same-day edits collapse to one row
);
COMMENT ON TABLE ledger.default_rates IS
  'Global default rate per activity type, effective-dated. NULL rate_cents = dated unset (falls through the ladder). Applies to a client only via its client_default_rate_optin switch.';

CREATE TABLE IF NOT EXISTS ledger.client_default_rate_optin (
  client_id        uuid NOT NULL REFERENCES shared.clients(id) ON DELETE CASCADE,
  activity_type_id uuid REFERENCES ledger.activity_types(id) ON DELETE CASCADE,
  valid_from       date NOT NULL,
  enabled          boolean NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS client_default_optin_typed_key ON ledger.client_default_rate_optin
  (client_id, valid_from, activity_type_id) WHERE activity_type_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS client_default_optin_wide_key ON ledger.client_default_rate_optin
  (client_id, valid_from) WHERE activity_type_id IS NULL;
COMMENT ON TABLE ledger.client_default_rate_optin IS
  'activity_type_id NULL = the client''s "use global default rates" switch (default off); non-NULL = per-type inherit toggle (default on while the switch is on). Effective-dated: a flip today never re-prices earlier time.';

-- Function body is 0018's verbatim plus exactly the one gated default rung.
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
      -- NEW (0029): global default, only while the client's switch was on
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
