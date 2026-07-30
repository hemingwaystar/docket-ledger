-- 0019 — the automations engine (rules + triggers + SLA fan-out) grows its
-- storage. Until now desk.automation_rules was a parked table: the builder
-- UIs existed but nothing executed. This migration gives the engine what the
-- prototype's model actually needs, an event outbox so desk-api mutations and
-- mail ingestion feed ONE evaluator (in mail-worker), a notifications table
-- for the bell, and an SLA-notice ledger so warnings/breaches fan out once.
BEGIN;

-- --- rules: match the prototype's vocabulary ------------------------------
-- Prototype trigger events are create/followup/state/priority/owner, with an
-- optional "…to state" value; rules run top-to-bottom (position); deletion is
-- archive-first per convention.
ALTER TABLE desk.automation_rules
  DROP CONSTRAINT IF EXISTS automation_rules_event_check;
ALTER TABLE desk.automation_rules
  ADD CONSTRAINT automation_rules_event_check
    CHECK (event IS NULL OR event IN ('create','followup','state','priority','owner'));
ALTER TABLE desk.automation_rules
  ADD COLUMN IF NOT EXISTS event_value text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS position    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archived    boolean NOT NULL DEFAULT false;

-- --- event outbox ---------------------------------------------------------
-- desk-api (manual create / props changes) and mail-worker (ingestion) both
-- INSERT; the worker consumes with FOR UPDATE SKIP LOCKED each pass. depth is
-- the recursion guard the 0001 comment promised: trigger actions that change
-- state/priority/owner enqueue follow-on events at depth+1; the engine stops
-- evaluating past depth 3.
CREATE TABLE desk.automation_events (
  id           bigserial PRIMARY KEY,
  event        text NOT NULL CHECK (event IN ('create','followup','state','priority','owner')),
  ticket_id    bigint NOT NULL REFERENCES desk.tickets(id) ON DELETE CASCADE,
  meta         jsonb NOT NULL DEFAULT '{}',    -- {from,subject,auto,...} for mail events
  depth        integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX ON desk.automation_events (processed_at) WHERE processed_at IS NULL;

-- --- notifications (the bell) --------------------------------------------
-- Targeted at an agent, a group (everyone in it), or broadcast (both NULL).
-- read_at is per-notification, not per-agent — good enough for a small shop;
-- SLA notices target the ticket's group so the right people see them.
CREATE TABLE desk.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL DEFAULT 'warn' CHECK (kind IN ('warn','breach','rule','info')),
  body       text NOT NULL,
  ticket_id  bigint REFERENCES desk.tickets(id) ON DELETE CASCADE,
  group_id   uuid REFERENCES shared.groups(id),
  agent_id   uuid REFERENCES shared.agents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX ON desk.notifications (created_at DESC);

-- --- SLA fan-out dedupe ---------------------------------------------------
-- One row per (ticket, clock, stage) — the scanner INSERTs before notifying,
-- and a conflict means "already told them". kind: fr|res, stage: warn|breach.
CREATE TABLE desk.sla_notices (
  ticket_id  bigint NOT NULL REFERENCES desk.tickets(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('fr','res')),
  stage      text NOT NULL CHECK (stage IN ('warn','breach')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, kind, stage)
);

-- --- config seeds (idempotent — Settings UI owns these afterwards) --------
INSERT INTO shared.app_config (key, value) VALUES
  ('sla', '{"1":{"fr":24,"res":120},"2":{"fr":8,"res":48},"3":{"fr":4,"res":24},"4":{"fr":1,"res":8}}')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO shared.app_config (key, value) VALUES
  ('business_hours', '{"days":[1,2,3,4,5],"start":8,"end":18,"holidays":[]}')
  ON CONFLICT (key) DO NOTHING;

-- --- grants ---------------------------------------------------------------
-- desk_api rides 0005's DEFAULT PRIVILEGES (S/I/U on new desk tables).
-- mail_worker gets exactly what the engine's statements need — audited
-- against every DML/read in services/mail-worker/app/automations.py:
GRANT SELECT, INSERT, UPDATE ON desk.automation_events TO mail_worker;
GRANT SELECT, INSERT         ON desk.notifications     TO mail_worker;
GRANT SELECT, INSERT         ON desk.sla_notices       TO mail_worker;
GRANT INSERT                 ON desk.round_robin_cursors TO mail_worker; -- first-use upsert (0001 gave only S/U)
GRANT SELECT                 ON desk.ticket_tags       TO mail_worker;   -- trigger "tags" conditions read them
GRANT SELECT                 ON desk.projects          TO mail_worker;   -- already granted in 0015; harmless repeat
GRANT SELECT                 ON ledger.activity_types  TO mail_worker;   -- harmless repeat (0001)

-- Docket's Directory tab manages activity type NAMES and lifecycle (create /
-- rename / archive) — the shared-control-plane part. Billable status and
-- rates stay Ledger-only (0017/0018). Column-scoped, same pattern as 0017's
-- "billing config lives in Ledger" grant; the sentinel guard trigger still
-- has the final word on archiving Unclassified.
GRANT INSERT               ON ledger.activity_types TO desk_api;
GRANT UPDATE (name, active) ON ledger.activity_types TO desk_api;

COMMIT;
