-- ============================================================================
-- 0033_ticket_schedules.sql — Build 16: per-tech time blocks on on-hold tickets.
--
-- WHY THIS TABLE EXISTS
--   The ticket case file gains a "Schedules" bar (next to the props panel) that
--   holds tech schedules for on-hold / paused tickets. Each row is ONE time
--   block: which agent is scheduled to work this held ticket, a START, an
--   optional END, and an optional note. A ticket can hold many blocks and an
--   agent can be scheduled on many tickets — a MANY-TO-MANY that lives in its
--   own child table, exactly like desk.ticket_assignees (0032) and NOT as a
--   column on desk.tickets. It is a per-ticket FIELD in the bootstrap, never a
--   new top-level key (the desk bootstrap key count is unchanged).
--
-- WHY THIS DRIVES AUTO-RESUME WITHOUT TOUCHING THE WORKER
--   Schedules REPLACE the old single hand-set "Wake up" field. The resume
--   mechanism is UNCHANGED: the mail-worker's wake_pending() already reopens
--   ANY ticket whose desk.tickets.pending_until <= now() (state → Open, clears
--   pending_until, writes a sys article + audit), and the frontend's
--   checkPendingWakes() mirrors that locally. So Schedules resume a ticket
--   purely by KEEPING desk.tickets.pending_until in sync with the EARLIEST
--   FUTURE scheduled start:
--       pending_until = MIN(starts_at) WHERE starts_at > now()   (NULL if none)
--   That derivation is done in the API (POST/DELETE below), which write
--   pending_until directly as a derived value. The mail-worker service is NOT
--   touched by this build — it consumes pending_until exactly as before.
--
-- WHY ticket_id IS bigint, NOT uuid
--   The cross-agent contract text said "ticket_id bigint" and that is correct:
--   desk.tickets.id is `bigint GENERATED ALWAYS AS IDENTITY` (0001_init.sql
--   line 271) and every ticket child table (ticket_tags, articles, ticket_links,
--   ticket_assignees) keys it as bigint. agent_id IS uuid because
--   shared.agents.id is uuid.
--
-- WHY id IS GENERATED ALWAYS AS IDENTITY (and why NO explicit sequence grant)
--   Unlike ticket_assignees (whose natural key is the composite (ticket_id,
--   agent_id)), a schedule has no natural key — the same tech can be scheduled
--   twice on the same ticket for two different blocks — so it needs a surrogate
--   PK. We use `bigint GENERATED ALWAYS AS IDENTITY`, matching desk.tickets and
--   the DELETE-by-id / bootstrap-emit shape the API needs.
--
--   Does desk_api need a grant on the identity's implicit sequence to INSERT?
--   NO — verified two independent ways:
--     1. An identity column's owned sequence is advanced by the identity
--        mechanism itself; the inserting role needs only INSERT on the TABLE,
--        not USAGE/SELECT on the sequence (this is the exact arrangement under
--        which desk_api already INSERTs into desk.tickets, also GENERATED
--        ALWAYS AS IDENTITY, with no table-specific sequence grant). This is
--        unlike a serial / DEFAULT nextval() column, whose default IS evaluated
--        with the caller's privileges and DOES require sequence USAGE.
--     2. Even if it were checked, 0005's
--          ALTER DEFAULT PRIVILEGES IN SCHEMA desk GRANT USAGE ON SEQUENCES
--          TO desk_api, ledger_api, mail_worker
--        already covers every sequence created with a new desk table after 0005
--        (the same default-privileges umbrella under which 0025's ticket_links
--        landed carrying no grants of its own).
--   So we add NO sequence grant here — one would be redundant and would have to
--   hardcode the auto-generated sequence name. INSERT on the table is enough.
--
-- WHY THE REMOVE ENDPOINT MAY DELETE FROM THIS TABLE
--   DELETE /api/tickets/{id}/schedules/{schedule_id} removes one block. That
--   DELETE is in-doctrine: the no-DELETE rule guards BUSINESS RECORDS, not
--   child/membership rows. This is the SAME exception already carved for
--   shared.agent_groups (0011), desk.ticket_tags (0009), and desk.ticket_assignees
--   (0032). The audit line the API writes on removal is the durable history; the
--   schedule row itself is just current state (and the block's own sys article,
--   written when it was added, remains on the ticket).
--
-- GRANTS (verified against 0001 + 0005 + 0011/0032, the precedents)
--   desk_api already receives SELECT/INSERT/UPDATE on EVERY new table in schema
--   desk via 0005's ALTER DEFAULT PRIVILEGES. The one privilege those defaults
--   deliberately withhold is DELETE — that omission IS the no-DELETE doctrine —
--   so we grant DELETE explicitly, mirroring 0011's agent_groups and 0032's
--   ticket_assignees. SELECT/INSERT are restated for a self-contained,
--   audit-legible block; GRANTs are idempotent so the restatement is a harmless
--   no-op where 0005's defaults already cover them. Only desk_api touches this
--   table — the worker reads pending_until off desk.tickets, never the schedule
--   rows, and ledger has no business here.
--
-- Transactional + idempotent (build-8b hardening): CREATE ... IF NOT EXISTS and
-- idempotent GRANTs, all inside one txn, so a failed or partial apply leaves
-- nothing behind and a re-run is clean.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS desk.ticket_schedules (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id  bigint      NOT NULL REFERENCES desk.tickets(id) ON DELETE CASCADE,
  agent_id   uuid        NOT NULL REFERENCES shared.agents(id),
  starts_at  timestamptz NOT NULL,       -- block start; MIN future start drives auto-resume
  ends_at    timestamptz,                -- optional block end
  note       text,                       -- optional free-text note
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);

-- (ticket_id) index: the bootstrap aggregate and both endpoints filter/sort by
-- ticket_id — the primary access path (the PK on id does not serve it).
CREATE INDEX IF NOT EXISTS ticket_schedules_ticket_idx
  ON desk.ticket_schedules (ticket_id);
-- (agent_id) index: the reverse lookup — "every ticket this tech is scheduled
-- on" — for a future per-tech schedule view, mirroring 0032's agent index.
CREATE INDEX IF NOT EXISTS ticket_schedules_agent_idx
  ON desk.ticket_schedules (agent_id);

GRANT SELECT, INSERT ON desk.ticket_schedules TO desk_api;  -- redundant w/ 0005 defaults; explicit for legibility
GRANT DELETE         ON desk.ticket_schedules TO desk_api;  -- load-bearing: mirrors 0011/0032 (child-row removal)

COMMIT;
