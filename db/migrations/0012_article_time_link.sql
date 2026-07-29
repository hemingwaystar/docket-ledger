-- ============================================================================
-- 0012_article_time_link.sql — two things the ticket-side time UX needs:
--
-- 1) ledger.time_entries.article_id — which note/reply a time entry rides on.
--    Until now the article↔chip link existed only in the prototype's local
--    state, so "+ time" on a note (and chips on composed notes) vanished on
--    every hydrate. Nullable: standalone entries stay legal.
--
-- 2) ledger.guard_entry_immutability becomes SECURITY DEFINER (the 0006
--    treatment). The guard reads billing_periods with the CALLING role's
--    rights; desk_api rightly has no grants there, so its first-ever UPDATE
--    on a time entry (edit span / reclassify / void from the ticket) would
--    have been refused by the guard itself — the "edits (triggers gate)"
--    grant in 0001 was never actually exercisable. Definer rights keep the
--    segmentation: desk_api still can't read periods, the invariant still
--    fires on every UPDATE/DELETE.
-- ============================================================================
BEGIN;

ALTER TABLE ledger.time_entries
  ADD COLUMN article_id uuid REFERENCES desk.articles(id);
CREATE INDEX time_entries_article_idx ON ledger.time_entries (article_id)
  WHERE article_id IS NOT NULL;

ALTER FUNCTION ledger.guard_entry_immutability() SECURITY DEFINER;
ALTER FUNCTION ledger.guard_entry_immutability() SET search_path = ledger, shared, pg_temp;

COMMIT;
