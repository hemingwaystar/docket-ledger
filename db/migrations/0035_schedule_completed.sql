-- ============================================================================
-- 0035_schedule_completed.sql — Build 19: mark a tech's schedule block complete.
--
-- WHY THESE TWO COLUMNS EXIST
--   A schedule block (desk.ticket_schedules, 0033) can now be checked off as
--   done. A completed block renders STRUCK THROUGH everywhere it shows — the
--   ticket case-file "Schedules" bar and the new Schedule calendar (build 18).
--   Completion is per-row state that must survive reload and be visible to
--   every agent, so it lives on the row, not in local UI state. Two columns:
--       completed_at  — when it was marked done   (NULL = not completed)
--       completed_by  — the actor's display name/label at completion time
--   Both nullable, no backfill: the whole existing corpus rides through as
--   NULL = "not completed", exactly the not-done state. These are per-schedule
--   FIELDS in the bootstrap (completedAt/completedBy on each schedule object),
--   NOT new top-level keys — the desk bootstrap key count is unchanged.
--
-- WHY completed_by IS text (not an agent uuid FK)
--   It mirrors desk.articles.edited_by (0034) and ticket_schedules.created_by
--   (0033): a plain display name/label captured at the moment of the action,
--   the same value the audit line and the sys article carry. It records WHO
--   acted (which may be a PAT/service label), not a foreign key into agents.
--
-- WHY completed BLOCKS ARE EXCLUDED FROM AUTO-RESUME
--   Build 16's contract: desk.tickets.pending_until = MIN(starts_at) among the
--   ticket's FUTURE schedule rows drives the off-hold wake. A block that is
--   DONE should not still reopen the ticket at its start, so the derivation in
--   the API (_sync_pending, write.py) now also filters `completed_at IS NULL`.
--   That is an API-side change; nothing in this migration or the mail-worker
--   changes — the worker still consumes pending_until exactly as before.
--
-- WHY NO NEW GRANT
--   desk_api already holds UPDATE on every table in schema desk (0001:762),
--   which covers these new columns — the complete/reopen toggle is an UPDATE of
--   an existing row, so NO new grant is needed (same reasoning as 0034's
--   edited_at/edited_by on desk.articles). Only desk_api touches this table.
--
-- Transactional + idempotent (build-8b hardening): ADD COLUMN IF NOT EXISTS
-- inside one txn, so a failed or partial apply leaves nothing behind and a
-- re-run is clean.
-- ============================================================================
BEGIN;

ALTER TABLE desk.ticket_schedules
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_by text;

COMMIT;
