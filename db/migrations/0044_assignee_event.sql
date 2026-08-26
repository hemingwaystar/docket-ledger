-- ============================================================================
-- 0044_assignee_event.sql — 'assignee' joins the automation event vocabulary
-- (audit): adding a tech as an additional assignee (0032) emitted no event,
-- so no trigger or notification could ever reach them — the fan-out half of
-- multi-assignee looked wired but silently did nothing. The CHECKs on both
-- the rules table and the event outbox gain the new value; desk-api emits it
-- from set_assignees and the worker's engine + builder UI understand it.
-- Transactional + idempotent (build-8b rules).
-- ============================================================================
BEGIN;

ALTER TABLE desk.automation_rules
  DROP CONSTRAINT IF EXISTS automation_rules_event_check;
ALTER TABLE desk.automation_rules
  ADD CONSTRAINT automation_rules_event_check
    CHECK (event IS NULL OR event IN ('create','followup','state','priority','owner','assignee'));

ALTER TABLE desk.automation_events
  DROP CONSTRAINT IF EXISTS automation_events_event_check;
ALTER TABLE desk.automation_events
  ADD CONSTRAINT automation_events_event_check
    CHECK (event IN ('create','followup','state','priority','owner','assignee'));

COMMIT;
