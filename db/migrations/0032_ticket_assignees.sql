-- ============================================================================
-- 0032_ticket_assignees.sql — Build 15: multiple assigned techs per ticket.
--
-- WHY THIS TABLE EXISTS
--   A ticket has exactly ONE owner (desk.tickets.owner_id — one agent, gated
--   can('assign'), unchanged by this build). Build 15 adds a SECOND, orthogonal
--   concept: ADDITIONAL assigned techs. An assignee is not the owner; they gain
--   view access (view_own extends to assignees) and the ticket shows up in their
--   "Mine" / "Assigned to me" lists. Owner and assignee both count as "mine" and
--   are deduped by an OR in the UI — the owner is NOT auto-added as an assignee.
--
--   That is a MANY-TO-MANY relationship (a ticket has many techs; a tech has
--   many tickets), so it lives in its own membership join table — exactly the
--   shape of shared.agent_groups (agent ↔ group). It is deliberately NOT a
--   column on desk.tickets and NOT a new top-level bootstrap key.
--
-- WHY ticket_id IS bigint, NOT uuid
--   The cross-agent contract text said "ticket_id uuid", but desk.tickets.id is
--   `bigint GENERATED ALWAYS AS IDENTITY` (see 0001_init.sql line 271), and every
--   other ticket child table keys it as bigint (desk.ticket_tags, desk.articles,
--   desk.ticket_links). A uuid FK referencing a bigint PK is a hard type error —
--   the migration would refuse to apply. So ticket_id is bigint to match the
--   parent PK. agent_id IS uuid, because shared.agents.id is uuid.
--
-- WHY THE FULL-LIST REPLACE ENDPOINT MAY DELETE FROM THIS TABLE
--   PUT /api/tickets/{id}/assignees replaces the whole membership set, which
--   means deleting rows that fell out of the set. That DELETE is legitimate and
--   in-doctrine: the no-DELETE rule guards BUSINESS RECORDS, not membership
--   joins. This is the SAME exception already carved out for shared.agent_groups
--   in 0011 ("patch_agent rewrites group membership by replace") and for
--   desk.ticket_tags in 0009. The audit line + the per-change sys article on the
--   ticket are the durable history; the join row itself is just current state.
--
-- GRANTS (verified against 0001 + 0005 + 0011, the agent_groups precedent)
--   desk_api already receives SELECT/INSERT/UPDATE on EVERY new table in schema
--   desk via 0005's `ALTER DEFAULT PRIVILEGES IN SCHEMA desk ... TO desk_api`
--   (this is exactly how desk.ticket_links landed in 0025 carrying no grants of
--   its own). The one privilege default-privileges deliberately withholds is
--   DELETE — that omission IS the no-DELETE doctrine. A membership join needs
--   DELETE for full-list replace, so we grant it explicitly here, mirroring
--   0011's `GRANT DELETE ON shared.agent_groups TO desk_api;` exactly (same role,
--   same reason). SELECT/INSERT are restated for a self-contained, audit-legible
--   block; GRANTs are idempotent, so the restatement is a harmless no-op when
--   0005's defaults have already covered them. Only desk_api touches this table —
--   the worker and ledger have no business reading ticket assignees.
--
-- Transactional + idempotent (build-8b hardening): CREATE ... IF NOT EXISTS and
-- idempotent GRANTs, all inside one txn, so a failed or partial apply leaves
-- nothing behind and a re-run is clean.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS desk.ticket_assignees (
  ticket_id  bigint      NOT NULL REFERENCES desk.tickets(id) ON DELETE CASCADE,
  agent_id   uuid        NOT NULL REFERENCES shared.agents(id),
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   text,
  PRIMARY KEY (ticket_id, agent_id)
);

-- The composite PK already indexes (ticket_id, agent_id), which serves the
-- bootstrap aggregate (GROUP BY ticket_id, leading column). This secondary
-- index serves the reverse lookup — "every ticket assigned to agent X" — the
-- core "Assigned to me" query pattern, mirroring desk.tickets' owner index.
CREATE INDEX IF NOT EXISTS ticket_assignees_agent_idx
  ON desk.ticket_assignees (agent_id);

GRANT SELECT, INSERT ON desk.ticket_assignees TO desk_api;  -- redundant w/ 0005 defaults; explicit for legibility
GRANT DELETE         ON desk.ticket_assignees TO desk_api;  -- load-bearing: mirrors 0011's agent_groups DELETE (full-list replace)

COMMIT;
