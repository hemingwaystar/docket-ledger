-- ============================================================================
-- 0043_retainers_wired.sql — the retainer/block-hours agreement editor
-- persists (audit: the whole feature was UI-local — terms typed into the
-- per-client editor and the Settings module toggle were wiped by the next
-- hydrate while looking fully wired).
--
--   * enabled: the per-client agreement switch the UI already models —
--     rows survive a disable (no-DELETE doctrine), history intact.
--   * note: the editor's free-text line.
--   * overage_rate_cents goes NULLABLE: the UI's "standard rates" state
--     (charge overage at the normal pricing ladder) was unrepresentable.
-- ledger_api already holds INSERT/UPDATE on ledger.* (0001:770).
-- Transactional + idempotent (build-8b rules).
-- ============================================================================
BEGIN;

ALTER TABLE ledger.retainers
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS note    text    NOT NULL DEFAULT '';
ALTER TABLE ledger.retainers ALTER COLUMN overage_rate_cents DROP NOT NULL;

COMMIT;
