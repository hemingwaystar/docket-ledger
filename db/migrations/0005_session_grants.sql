-- ============================================================================
-- 0005_session_grants.sql — grants for shared.sessions (created in 0004 after
-- 0001's ON ALL TABLES grants had already run), plus DEFAULT PRIVILEGES so
-- every future table lands with the right permissions automatically and this
-- class of bug is structurally gone.
-- Doctrine note: sessions are the ONE deliberate DELETE exception — expired
-- login sessions are ephemeral auth artifacts, swept by desk-api at sign-in.
-- Business data remains void/archive-only with DELETE granted nowhere.
-- ============================================================================
BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON shared.sessions TO desk_api;
GRANT SELECT ON shared.sessions TO ledger_api;

ALTER DEFAULT PRIVILEGES IN SCHEMA shared
  GRANT SELECT, INSERT, UPDATE ON TABLES TO desk_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared
  GRANT SELECT ON TABLES TO ledger_api, mail_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA desk
  GRANT SELECT, INSERT, UPDATE ON TABLES TO desk_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ledger_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit
  GRANT SELECT, INSERT ON TABLES TO desk_api, ledger_api, mail_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared
  GRANT USAGE ON SEQUENCES TO desk_api, ledger_api, mail_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA desk
  GRANT USAGE ON SEQUENCES TO desk_api, ledger_api, mail_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger
  GRANT USAGE ON SEQUENCES TO desk_api, ledger_api, mail_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit
  GRANT USAGE ON SEQUENCES TO desk_api, ledger_api, mail_worker;

COMMIT;
