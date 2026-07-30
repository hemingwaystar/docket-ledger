-- 0025_ticket_links.sql — ticket links: "related" (symmetric) and
-- "child" (directed, one level deep), plus the system close state that
-- makes parent-close cascades automation-silent.
--
-- Design (locked 2026-07-30 with the user):
--   * Hierarchy is STRICTLY one level. A parent may have any number of
--     children; a child can NEVER itself be a parent — the API refuses
--     with an explicit message, and the UI says the same before asking.
--     One live parent per child (partial unique below).
--   * Closing a parent offers to cascade its open children. Cascaded
--     children land in 'Closed: child ticket' — a done-kind SYSTEM state
--     seeded here — so triggers keyed "state → Closed/Solved" never
--     match and no per-child close email fires. The state itself is the
--     suppression mechanism: zero engine changes, visible on the ticket,
--     and deliberately targetable if a child-close automation is ever
--     wanted. System states are cascade-written only: the manual state
--     pickers exclude them and the settings surface can't archive them.
--   * No DELETE anywhere (house rule): unlink is a void (voided_at/by),
--     so link history survives.
--
-- Grants: 0005's DEFAULT PRIVILEGES cover the new table for desk_api.

CREATE TABLE desk.ticket_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('related', 'child')),
  -- kind='child': src is the PARENT, dst is the CHILD.
  -- kind='related': symmetric; stored once, read both directions.
  src_id     bigint NOT NULL REFERENCES desk.tickets(id),
  dst_id     bigint NOT NULL REFERENCES desk.tickets(id),
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at  timestamptz,
  voided_by  text,
  CHECK (src_id <> dst_id)
);
CREATE INDEX ticket_links_src_idx ON desk.ticket_links (src_id) WHERE voided_at IS NULL;
CREATE INDEX ticket_links_dst_idx ON desk.ticket_links (dst_id) WHERE voided_at IS NULL;
-- one live parent per child:
CREATE UNIQUE INDEX ticket_links_one_parent
  ON desk.ticket_links (dst_id) WHERE kind = 'child' AND voided_at IS NULL;
-- one live related link per pair, either direction:
CREATE UNIQUE INDEX ticket_links_related_pair
  ON desk.ticket_links (LEAST(src_id, dst_id), GREATEST(src_id, dst_id))
  WHERE kind = 'related' AND voided_at IS NULL;

-- system states: written by the machine, not pickable by hand
ALTER TABLE desk.ticket_states
  ADD COLUMN is_system boolean NOT NULL DEFAULT false;

INSERT INTO desk.ticket_states (label, kind, is_core, active, position, is_system)
VALUES ('Closed: child ticket', 'done', true, true, 7, true);
