-- ============================================================================
-- 0007 — Graph ingestion state. We poll (delta queries) rather than depend on
-- webhook subscriptions: no inbound port, no renewal race, right-sized for MSP
-- volume. subscription_id becomes optional (webhooks can layer on later);
-- delta_link is the per-mailbox resume cursor.
-- ============================================================================
BEGIN;

ALTER TABLE desk.graph_subscriptions ALTER COLUMN subscription_id DROP NOT NULL;
ALTER TABLE desk.graph_subscriptions ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE desk.graph_subscriptions ADD COLUMN delta_link text;

GRANT INSERT ON desk.graph_subscriptions TO mail_worker;
GRANT SELECT, INSERT, UPDATE ON desk.mailboxes TO desk_api;   -- settings UI manages these
GRANT SELECT ON shared.secrets TO mail_worker;                -- reads the sealed Graph secret

COMMIT;
