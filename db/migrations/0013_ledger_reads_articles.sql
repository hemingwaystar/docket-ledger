-- ============================================================================
-- 0013_ledger_reads_articles.sql — Ledger displays the text of the Docket
-- note/reply an entry rides on (time_entries.article_id, 0012) as the entry's
-- content when its own note is blank. That read needs SELECT on
-- desk.articles, which ledger_api never had — caught in review this time,
-- and a reminder that the DML audit (bug #17) only covered write verbs:
-- cross-schema SELECT joins are the same class and now get checked too.
-- ============================================================================
BEGIN;

GRANT SELECT ON desk.articles TO ledger_api;

COMMIT;
