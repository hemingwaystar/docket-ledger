-- ============================================================================
-- 0041_contact_fields.sql — persist the contact form's Preferred-contact,
-- Fax and Notes fields (audit: rendered and read since the prototype, but
-- never sent, stored, or hydrated — everything typed was silently lost on
-- the next hydrate). Columns default sensibly for the mail-worker's
-- auto-created contacts. Transactional + idempotent (build-8b rules).
-- ============================================================================
BEGIN;

ALTER TABLE shared.contacts
  ADD COLUMN IF NOT EXISTS pref  text NOT NULL DEFAULT 'email'
    CHECK (pref IN ('email', 'sms', 'phone', 'fax')),
  ADD COLUMN IF NOT EXISTS fax   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '';

COMMIT;
