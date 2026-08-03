-- ============================================================================
-- 0034_article_edited.sql — Build 17: editable internal notes.
--
-- WHY THESE TWO COLUMNS EXIST
--   A sent internal note (desk.articles.kind='note') can now be edited after
--   the fact — its body corrected and attachments added. Transparency demands
--   the thread SHOW that it was touched, so every edit stamps:
--       edited_at  — when it was last edited      (NULL = never edited)
--       edited_by  — the actor's display name/label at edit time
--   The UI renders a muted "(edited <when>)" marker off edited_at; both columns
--   are nullable so the whole existing corpus (and every never-edited note)
--   rides through as null with no backfill. They are per-ARTICLE fields in the
--   bootstrap, NOT new top-level keys — the desk bootstrap key count is
--   unchanged.
--
-- WHY NO CHANGE TO THE IMMUTABILITY GUARD (and why UPDATE already works)
--   desk.guard_article_immutability() (0001_init.sql:326) is a BEFORE UPDATE
--   trigger that raises ONLY when a NON-note article's body changes:
--       IF OLD.kind <> 'note' AND NEW.body IS DISTINCT FROM OLD.body ...
--   For a note (OLD.kind='note') the guard never fires, so editing a note's
--   body is already permitted; and setting edited_at/edited_by on ANY row is
--   permitted regardless of kind because the guard only inspects body. So the
--   note-body edit needs NO guard change — we deliberately do NOT touch it.
--   desk_api already holds UPDATE on every table in schema desk (0001:762),
--   which covers these new columns — NO new grant is needed for the desk side.
--
-- WHY ledger.period_locked() EXISTS (the ONE piece of new machinery)
--   The edit endpoint MUST refuse (server-authoritative, not merely UI-hidden)
--   when the note's linked timesheet is frozen: either the linked
--   ledger.time_entries row is manager-approved (ts_approved_at IS NOT NULL) OR
--   it sits in a LOCKED billing period (billing_periods.status IN
--   ('approved','exported')). desk_api can already read ledger.time_entries
--   (0001:771), so ts_approved_at is a direct read — but it deliberately CANNOT
--   read ledger.billing_periods. That segmentation is intentional and was twice
--   preserved on purpose: 0006 and 0012 made ledger.ensure_period() and
--   ledger.guard_entry_immutability() SECURITY DEFINER precisely so "desk_api
--   still cannot read or write periods itself."
--
--   Critically, that guard cannot protect us here: the edit UPDATEs
--   desk.articles, NOT ledger.time_entries, so guard_entry_immutability never
--   fires. The endpoint itself must be the enforcer, which means desk_api needs
--   to LEARN the period's locked-ness without gaining a billing_periods read.
--   The house answer (0003/0006/0012) is a SECURITY DEFINER ledger function:
--   period_locked(period_id) runs with the definer's rights, returns a single
--   boolean, and is the ONLY new thing desk_api may call — the segmentation
--   holds (desk_api still cannot SELECT billing_periods). It also feeds the
--   bootstrap's per-entry time[].locked flag so the UI can gate the Edit
--   affordance identically to the server (a period-locked-but-not-ts_approved
--   entry IS reachable — approve_period locks a period without requiring each
--   entry to be ts_approved first).
--
--   NULL period_id (an entry not yet assigned to a period) is NOT locked — the
--   EXISTS yields false, which is correct. STABLE: it reads a table, no writes.
--   search_path is pinned (definer-safety, mirroring 0006/0012). EXECUTE goes
--   to desk_api only — ledger_api reads billing_periods directly and the worker
--   has no business here.
--
-- Transactional + idempotent (build-8b hardening): ADD COLUMN IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION, and idempotent GRANT, all inside one txn, so a
-- failed or partial apply leaves nothing behind and a re-run is clean.
-- ============================================================================
BEGIN;

-- (1) transparency columns — nullable, no backfill (see header).
ALTER TABLE desk.articles
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS edited_by text;

-- (2) the period-lock read desk_api lacks, as a SECURITY DEFINER function so
--     the segmentation (desk_api cannot read billing_periods) is preserved.
CREATE OR REPLACE FUNCTION ledger.period_locked(p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ledger, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM ledger.billing_periods bp
                  WHERE bp.id = p_id AND bp.status IN ('approved', 'exported'));
$$;

GRANT EXECUTE ON FUNCTION ledger.period_locked(uuid) TO desk_api;

COMMIT;
