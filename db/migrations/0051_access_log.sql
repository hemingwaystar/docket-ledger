-- ============================================================================
-- 0051_access_log.sql — HIPAA review #7: record who ACCESSED what
-- (§164.312(b) audit controls). audit.events records changes; this records
-- reads and disclosures:
--   ticket_view   a ticket opened in the Docket UI (any path that lands on it)
--   ticket_read   GET /api/tickets/{id} (API detail read)
--   ticket_list   GET /api/tickets (API list read — the ids that came back)
--   entry_list    GET /api/entries on Ledger (time-entry notes can carry PHI)
--   attachment    an attachment downloaded / opened
--   workspace     a Docket or Ledger page load (bootstrap) — how many tickets
--                 or entries the session received
--   export        a CSV export or clipboard copy (client-side exports report
--                 in here; rows = how many were exported)
-- Append-only: runtime roles get SELECT + INSERT, never UPDATE/DELETE. Read
-- back only by holders of the audit permission (GET /api/access, view_audit).
-- Transactional + idempotent (build-8b rules). Runs as postgres (superuser).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS audit.access (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text        NOT NULL DEFAULT shared.current_actor(),
  agent_id    uuid REFERENCES shared.agents(id),
  app         text        NOT NULL CHECK (app IN ('desk', 'ledger')),
  kind        text        NOT NULL CHECK (kind IN ('ticket_view', 'ticket_read',
                           'ticket_list', 'entry_list', 'attachment',
                           'workspace', 'export')),
  ticket_id   bigint,                        -- no FK: merged/renumbered tickets keep their trail
  detail      text        NOT NULL DEFAULT '',
  ip          text,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS access_at_idx     ON audit.access (at DESC);
CREATE INDEX IF NOT EXISTS access_ticket_idx ON audit.access (ticket_id, at DESC)
  WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS access_agent_idx  ON audit.access (agent_id, at DESC);

GRANT SELECT, INSERT ON audit.access TO desk_api, ledger_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA audit TO desk_api, ledger_api;

COMMIT;
