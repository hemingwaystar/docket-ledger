-- ============================================================================
-- 0049_session_idle_live_perms.sql — HIPAA review (2026-09-25) #1 and #4.
--   * shared.sessions.last_seen_at: the last USER activity on a session. Every
--     service's auth.require() refuses a session idle longer than
--     app_config auth.idle_minutes (default 15, clamped 5..480) and bumps
--     the stamp on non-passive requests (background polls send
--     X-HTS-Passive: 1 and never keep a session alive). Automatic logoff,
--     §164.312(a)(2)(iii).
--   * Permissions are now read LIVE from the agent's role on every request
--     (auth.require), not from the sign-in snapshot in sessions.perms — a
--     role change or a role's permission edit applies on the next request
--     instead of lasting until the session expired (up to 12 h). The perms
--     column stays as the sign-in record; nothing reads it for RBAC now.
--   * ledger_api / assets_api share desk's sessions, so they get UPDATE on
--     exactly the activity column.
-- Transactional + idempotent (build-8b rules). Runs as postgres (superuser).
-- ============================================================================
BEGIN;

ALTER TABLE shared.sessions
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
-- sessions minted before this migration count as active from now — nobody
-- is signed out by the deploy itself
UPDATE shared.sessions SET last_seen_at = now()
 WHERE last_seen_at IS NULL AND revoked_at IS NULL AND expires_at > now();
ALTER TABLE shared.sessions ALTER COLUMN last_seen_at SET DEFAULT now();

GRANT UPDATE (last_seen_at) ON shared.sessions TO ledger_api, assets_api;
GRANT SELECT ON shared.sessions TO assets_api;

COMMIT;
