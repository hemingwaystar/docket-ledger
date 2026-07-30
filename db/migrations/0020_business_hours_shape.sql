-- 0020 — bug #29: 0002 seeded business_hours with "08:00"/"18:00" STRINGS;
-- 0019's numeric seed lost to ON CONFLICT DO NOTHING, so both SLA consumers
-- choked on the string shape: the UI's isBizTime() compared numbers to
-- "08:00" (always false → every due time guard-capped at 40,000 × 15 min =
-- the "in 416d" screenshot), and the worker's float("08:00") raised every
-- pass — which skipped commit and ROLLED BACK the whole pass, mail ingestion
-- included. Normalize the row in place, preserving any customized values:
-- "HH:MM" → fractional hours, bare numbers pass through, holidays added if
-- missing. Idempotent — a numeric row with holidays is left untouched.
BEGIN;

WITH fixed AS (
UPDATE shared.app_config
   SET value = jsonb_build_object(
         'days',     COALESCE(value->'days', '[1,2,3,4,5]'::jsonb),
         'start',    CASE WHEN jsonb_typeof(value->'start') = 'string'
                          THEN to_jsonb(split_part(value->>'start', ':', 1)::numeric
                               + COALESCE(NULLIF(split_part(value->>'start', ':', 2), '')::numeric, 0) / 60)
                          ELSE COALESCE(value->'start', '8'::jsonb) END,
         'end',      CASE WHEN jsonb_typeof(value->'end') = 'string'
                          THEN to_jsonb(split_part(value->>'end', ':', 1)::numeric
                               + COALESCE(NULLIF(split_part(value->>'end', ':', 2), '')::numeric, 0) / 60)
                          ELSE COALESCE(value->'end', '18'::jsonb) END,
         'holidays', COALESCE(value->'holidays', '[]'::jsonb))
         || COALESCE(value - 'days' - 'start' - 'end' - 'holidays', '{}'::jsonb),
       version = version + 1
 WHERE key = 'business_hours'
   AND (jsonb_typeof(value->'start') = 'string'
        OR jsonb_typeof(value->'end') = 'string'
        OR value->'holidays' IS NULL)
 RETURNING 1
)
INSERT INTO audit.events (app, action, entity, detail)
SELECT 'desk', 'Config normalized', 'config:business_hours',
       'bug #29 — 0002''s "HH:MM" strings → numeric hours; SLA math and the worker pass depend on it'
 WHERE EXISTS (SELECT 1 FROM fixed);

COMMIT;
