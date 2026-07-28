-- ============================================================================
-- 0008 — outbound mail config. Ships DISABLED: replies are recorded in the
-- thread but not transmitted until {"outbound_enabled": true} is set via
-- PUT /api/settings/config/mail. First build where the system can email real
-- customers, so the default is "prove it on test tickets first".
-- ============================================================================
BEGIN;
INSERT INTO shared.app_config (key, value)
VALUES ('mail', '{"outbound_enabled": false}')
ON CONFLICT (key) DO NOTHING;
COMMIT;
