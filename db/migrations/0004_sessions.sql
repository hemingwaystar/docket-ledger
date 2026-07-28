-- ============================================================================
-- 0004_sessions.sql — browser sessions, shared by desk-api and ledger-api.
-- Opaque random token in an HttpOnly cookie; sha256 hash stored here.
-- Permissions are SNAPSHOTTED at sign-in (§10.2: role table read at sign-in;
-- matrix edits apply on the next login). ledger-api validates read-only.
-- ============================================================================
BEGIN;

CREATE TABLE shared.sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  agent_id    uuid NOT NULL REFERENCES shared.agents(id),
  perms       text[] NOT NULL DEFAULT '{}',      -- snapshot of the role matrix
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  ip          text,
  user_agent  text
);
CREATE INDEX sessions_agent_idx  ON shared.sessions (agent_id);
CREATE INDEX sessions_expiry_idx ON shared.sessions (expires_at);

COMMENT ON TABLE shared.sessions IS
  'Login sessions. desk-api creates/extends/revokes; ledger-api reads. '
  'Cleanup: desk-api login sweeps expired rows older than 30 days.';

COMMIT;
