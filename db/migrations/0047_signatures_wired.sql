-- ============================================================================
-- 0047_signatures_wired.sql — turn the desk.signatures stub (0001) into a real,
-- editable feature: a personal sign-off appended to outgoing replies, plus an
-- optional per-board (group) footer.
--   * one signature per owner — partial unique indexes so the editor can upsert
--     (ON CONFLICT) and a concurrent double-save can't leave two rows;
--   * audit stamps (updated_at/updated_by) so a changed board footer records who;
--   * desk_api may DELETE, so clearing a signature removes the row rather than
--     leaving an empty one behind (SELECT/INSERT/UPDATE were already granted on
--     every desk table in 0001; DELETE was not).
-- Transactional + idempotent (build-8b rules). Runs as postgres (superuser).
-- ============================================================================
BEGIN;

ALTER TABLE desk.signatures
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by text        NOT NULL DEFAULT shared.current_actor();

-- one signature per agent, one per group — partial to match the owner_kind
-- CHECK (agent rows carry agent_id, group rows carry group_id; never both).
CREATE UNIQUE INDEX IF NOT EXISTS signatures_one_per_agent
  ON desk.signatures (agent_id) WHERE owner_kind = 'agent';
CREATE UNIQUE INDEX IF NOT EXISTS signatures_one_per_group
  ON desk.signatures (group_id) WHERE owner_kind = 'group';

GRANT DELETE ON desk.signatures TO desk_api;

COMMIT;
