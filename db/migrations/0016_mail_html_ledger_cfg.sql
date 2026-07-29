-- ============================================================================
-- 0016_mail_html_ledger_cfg.sql — two independent additions:
--
-- 1) desk.articles.body_html — inbound HTML was tag-stripped at ingestion
--    (whitespace collapsed too, so even paragraphs died). The original HTML
--    now rides alongside the plain text; the UI renders it in a sandboxed,
--    CSP-fenced frame (no scripts, no remote loads) with a plain-text
--    toggle. Historical articles stay text-only — the HTML is gone.
--
-- 2) Ledger owns its own settings: app_config writes for its keys
--    ('ledger', 'odoo', 'retainers' — the API validates the key list) and
--    KEK-sealed write-only storage for the Odoo API key. INSERT/UPDATE only;
--    ledger_api already reads shared.* and plaintext secrets never leave the
--    write-only API on either app.
-- ============================================================================
BEGIN;

ALTER TABLE desk.articles ADD COLUMN body_html text;

GRANT INSERT, UPDATE ON shared.app_config TO ledger_api;
GRANT INSERT, UPDATE ON shared.secrets    TO ledger_api;

COMMIT;
