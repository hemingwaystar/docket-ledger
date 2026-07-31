-- 0026_group_sendas.sql — per-board outbound sender override (build 10).
--
-- Until now a board's replies always went out from its fed-by mailbox
-- (derived: the mailbox whose group_id points at the board). This table
-- lets an admin pick a different outbound-eligible mailbox per board;
-- a NULL (or absent) row means "keep the derived behavior". Clearing an
-- override is an UPDATE to NULL — no DELETE anywhere (house rule).
--
-- Resolution order (both resolvers — desk-api reply path and the worker's
-- trigger mailer): override → fed-by → refuse. Receive-only mailboxes are
-- refused at the API layer (422) and skipped by the resolvers.
--
-- Grants: 0005's DEFAULT PRIVILEGES cover desk_api for new desk tables;
-- the worker resolves senders too, so its SELECT must be explicit.
-- Transactional + idempotent (post-exit-3 rules, build 8b).
BEGIN;

CREATE TABLE IF NOT EXISTS desk.group_sendas (
  group_id   uuid PRIMARY KEY REFERENCES shared.groups(id),
  mailbox_id uuid REFERENCES desk.mailboxes(id),  -- NULL = follow fed-by
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON desk.group_sendas TO mail_worker;

COMMIT;
