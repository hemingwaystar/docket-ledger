-- 0027_state_decor.sql — per-state color + description (build 11).
--
-- Until now chip styling and the Settings-row subtitle came from a
-- hardcoded client-side catalog keyed by the CORE state ids; custom
-- states all rendered gray with no description. These columns make both
-- editable: color holds a palette TOKEN (one of the design system's chip
-- styles — validated at the API against the UI's own palette list, both
-- sides pinned to the same vocabulary), description is free text.
-- NULL in either column = the shipped default decor, so existing rows
-- render exactly as before this migration.
--
-- Grants: desk_api's blanket desk-schema DML (0001) covers both columns;
-- nothing else writes them. Transactional + idempotent (build-8b rules).
BEGIN;

ALTER TABLE desk.ticket_states
  ADD COLUMN IF NOT EXISTS color text,
  ADD COLUMN IF NOT EXISTS description text;

COMMIT;
