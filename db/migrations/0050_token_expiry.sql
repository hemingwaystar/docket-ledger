-- ============================================================================
-- 0050_token_expiry.sql — HIPAA review #10: personal access tokens (PATs).
--   * expires_at, NOT NULL: every token now dies on a date. Live tokens that
--     predate this get 90 days from the migration so integrations keep
--     working while they're re-minted; revoked ones take their revoke time.
--     scripts/create-token.sh sets it (default 90 days, max 365).
--   * auth.require (all three services) refuses expired tokens and tokens
--     whose owner (created_by) has been deactivated; a scoped token acts AS
--     its owner (visibility, own-rows rules) instead of bypassing them.
-- Transactional + idempotent (build-8b rules). Runs as postgres (superuser).
-- ============================================================================
BEGIN;

ALTER TABLE shared.api_tokens ADD COLUMN IF NOT EXISTS expires_at timestamptz;
-- backfill + audit in one statement: only rows set HERE are logged, so a
-- re-run (restore path) neither changes nor re-logs anything
WITH set_now AS (
  UPDATE shared.api_tokens
     SET expires_at = CASE WHEN revoked_at IS NOT NULL THEN revoked_at
                           ELSE now() + interval '90 days' END
   WHERE expires_at IS NULL
  RETURNING label, expires_at, revoked_at)
INSERT INTO audit.events (app, action, detail)
SELECT 'auth', 'API token expiry set',
       'label: ' || label || ' — existing token now expires ' ||
       to_char(expires_at, 'YYYY-MM-DD') || ' (0050)'
  FROM set_now WHERE revoked_at IS NULL;
ALTER TABLE shared.api_tokens ALTER COLUMN expires_at SET NOT NULL;

COMMIT;
