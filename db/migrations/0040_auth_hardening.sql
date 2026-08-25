-- ============================================================================
-- 0040_auth_hardening.sql — login brute-force throttle + TOTP replay pin
-- (audit HIGH cluster: no lockout/rate limit on /auth/login and the MFA
-- endpoints; TOTP codes reusable within the ±1-step window).
--
--   * shared.auth_throttle: per-key failure counter with a lazy 15-minute
--     window and a 15-minute lock after 5 failures. Keys are 'acct:<email>'
--     and 'ip:<addr>' — written by desk-api's /auth handlers (the one
--     sign-in service; ledger/assets never verify credentials). Rows are
--     internal garbage, not business data: DELETE is sanctioned here the
--     same way 0023 sanctioned the staged-upload sweep.
--   * shared.agents.last_totp_step: the highest accepted TOTP timestep —
--     a code at or behind it is a replay and is refused at login.
-- Transactional + idempotent (build-8b rules).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS shared.auth_throttle (
  key          text PRIMARY KEY,
  fails        integer     NOT NULL DEFAULT 1,
  window_start timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON shared.auth_throttle TO desk_api;

ALTER TABLE shared.agents ADD COLUMN IF NOT EXISTS last_totp_step bigint;

COMMIT;
