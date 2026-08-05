-- ============================================================================
-- 0036_article_deleted.sql — Build 26: deletable notes & public replies.
--
-- WHY THESE TWO COLUMNS EXIST
--   A sent internal note (kind='note') OR a public reply (kind='reply') can now
--   be DELETED after the fact — and, if it carries a time entry, that entry is
--   voided with it. "Deleted" is a SOFT delete: the row is tombstoned, never
--   removed, so the whole immutability/append-only story (and the audit trail)
--   stays intact. Every delete stamps:
--       deleted_at  — when it was deleted            (NULL = live)
--       deleted_by  — the actor's display name/label at delete time
--   The UI renders a muted "🗑 … deleted by <who> · <when>" TOMBSTONE in the
--   thread off deleted_at; the note's original content, the actor, and the time
--   land in BOTH the ticket Audit block and the global Audit Log (a sys article
--   + an audit.events row), differentiated note-vs-reply. Both columns are
--   nullable so the whole existing corpus (and every live article) rides through
--   as null with no backfill. They are per-ARTICLE fields in the bootstrap, NOT
--   new top-level keys — the desk bootstrap key count is unchanged.
--
-- WHY NO CHANGE TO THE IMMUTABILITY GUARD (and why the UPDATE is permitted)
--   desk.guard_article_immutability() (0001_init.sql:326) is a BEFORE UPDATE
--   trigger that raises ONLY when a NON-note article's BODY changes:
--       IF OLD.kind <> 'note' AND NEW.body IS DISTINCT FROM OLD.body ...
--   A soft-delete sets deleted_at/deleted_by and NEVER touches body. So:
--     * note  (OLD.kind='note')  — the guard never fires regardless; and
--     * reply (OLD.kind='reply') — NEW.body IS DISTINCT FROM OLD.body is FALSE
--       (body is left exactly as-is), so the guard never fires either.
--   Setting the two new columns on ANY row is therefore permitted with no guard
--   change — we deliberately do NOT touch the trigger. desk_api already holds
--   UPDATE on every table in schema desk (0001:762), which covers these new
--   columns — NO new grant is needed. mail_in / sys are refused by the endpoint,
--   not the trigger (only note/reply are deletable).
--
-- WHY THE LINKED TIME ENTRY IS VOIDED, NEVER DELETED
--   ledger.guard_entry_immutability() (0001:616) RAISEs 'time entries are never
--   deleted — void them' on any DELETE, and ledger.time_entries.article_id is a
--   plain (RESTRICT) FK to desk.articles(id) — so a hard delete is doubly
--   impossible and rightly so. The delete endpoint VOIDs each linked non-void
--   entry (status='void' + voided_at + void_reason) exactly as patch_time's "×"
--   already does, and refuses the whole operation (423) if ANY linked entry is
--   manager-approved (ts_approved_at) or sits in a locked/exported billing
--   period — reusing ledger.period_locked() (0034) so no billing_periods grant
--   is needed. The soft-delete is thus consistent with the "voids and archives
--   only, DELETE granted nowhere" invariant (0001:776).
--
-- Transactional + idempotent (build-8b hardening): ADD COLUMN IF NOT EXISTS
-- inside one txn, so a failed or partial apply leaves nothing behind and a
-- re-run is clean.
-- ============================================================================
BEGIN;

-- tombstone columns — nullable, no backfill (see header). No grant change
-- (desk_api already has UPDATE on schema desk) and no guard change (a soft
-- delete never alters body, so guard_article_immutability never fires).
ALTER TABLE desk.articles
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by text;

COMMIT;
