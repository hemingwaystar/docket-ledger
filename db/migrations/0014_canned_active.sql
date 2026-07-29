-- ============================================================================
-- 0014_canned_active.sql — canned responses get archive-first semantics.
-- The prototype's Delete button splices; the server never deletes business
-- text. active=false hides it from pickers, history keeps it.
-- ============================================================================
BEGIN;

ALTER TABLE desk.canned_responses
  ADD COLUMN active boolean NOT NULL DEFAULT true;

COMMIT;
