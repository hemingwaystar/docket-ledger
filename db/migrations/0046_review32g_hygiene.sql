-- ============================================================================
-- 0046_review32g_hygiene.sql — config/schema hygiene from the Build 32g review.
-- Three independent, idempotent fixes; none touches live billing/ticket data.
--   #7  seed the 'ledger' app_config row the code READS but nothing seeded
--   #8  normalize the 'verification' config drift (0002 snake_case vs the
--       camelCase verification.py reads; 0021's correct re-seed was DO NOTHING)
--   #9  drop the dead desk.verification_codes table (superseded by 0021's
--       desk.verifications; referenced by no code)
-- Transactional + idempotent (build-8b rules). Runs as postgres (superuser),
-- so no runtime-role grants are needed.
-- ============================================================================
BEGIN;

-- #7 --------------------------------------------------------------------------
-- helpers.py (_export_payload currency) and bootstrap.py (settings card) read
-- shared.app_config key 'ledger', but 0002 never seeded it — currency silently
-- defaulted to USD and the card rendered blank until an admin saved once.
INSERT INTO shared.app_config (key, value)
VALUES ('ledger', '{"currency": "USD"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- #8 --------------------------------------------------------------------------
-- The 0002 seed wrote 'verification' with snake_case keys (ttl_min,
-- post_to_thread) and provider 'voipms', but verification.py reads camelCase
-- (ttlMin/postToThread) and compares provider against the exact string
-- 'voip.ms'. 0021 re-seeded the correct camelCase shape but with
-- ON CONFLICT DO NOTHING, so on any DB first created by 0002 the fix never
-- landed. Rebuild the row into the exact shape the reader (and 0021) use,
-- PRESERVING any values, and only touch a row still carrying the snake_case
-- markers or the dotless provider — a row an operator has since saved through
-- the (camelCase-writing) settings card is left untouched. Idempotent: after
-- this runs the WHERE no longer matches.
UPDATE shared.app_config
   SET value = jsonb_build_object(
         'sms', jsonb_build_object(
             'enabled',   COALESCE((value->'sms'->>'enabled')::boolean, false),
             'provider',  'voip.ms',
             'did',       COALESCE(value->'sms'->>'did', ''),
             'apiUser',   COALESCE(value->'sms'->>'api_user', value->'sms'->>'apiUser', ''),
             'twilioSid', COALESCE(value->'sms'->>'twilioSid', '')),
         'email', jsonb_build_object(
             'enabled', COALESCE((value->'email'->>'enabled')::boolean, false),
             'from',    COALESCE(value->'email'->>'from', '')),
         'ttlMin',       COALESCE((value->>'ttl_min')::int, (value->>'ttlMin')::int, 5),
         'attempts',     COALESCE((value->>'attempts')::int, 3),
         'postToThread', COALESCE((value->>'post_to_thread')::boolean,
                                  (value->>'postToThread')::boolean, true))
 WHERE key = 'verification'
   AND (value ? 'ttl_min' OR value ? 'post_to_thread'
        OR value->'sms'->>'provider' = 'voipms'
        OR (value->'sms') ? 'api_user');

-- #9 --------------------------------------------------------------------------
-- desk.verification_codes (0001) was superseded by desk.verifications (0021)
-- and is referenced by no code. Drop it — but only if it exists AND is empty,
-- and WITHOUT cascade so the migration fails loudly (rather than silently
-- cascading) in the unexpected case that something still references it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'desk' AND table_name = 'verification_codes')
     AND NOT EXISTS (SELECT 1 FROM desk.verification_codes) THEN
    DROP TABLE desk.verification_codes;
  END IF;
END $$;

COMMIT;
