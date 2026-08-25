-- 0025_ticket_links.sql — ticket links: "related" (symmetric) and
-- "child" (directed, one level deep), plus the system close state that
-- makes parent-close cascades automation-silent.
--
-- Design (locked 2026-07-30 with the user):
--   * Hierarchy is STRICTLY one level. A parent may have any number of
--     children; a child can NEVER itself be a parent — the API refuses
--     with an explicit message, and the UI says the same before asking.
--     One live parent per child (partial unique below).
--   * Cascaded children land in 'Closed: child ticket' — a done-kind
--     SYSTEM state — so triggers keyed "state → Closed/Solved" never
--     match and no per-child close email fires. System states are
--     cascade-written only: manual pickers exclude them.
--   * No DELETE anywhere (house rule): unlink is a void.
--
-- Grants: 0005's DEFAULT PRIVILEGES cover the new table for desk_api.
-- Transactional + idempotent (post-exit-3 hardening, build 8b): a failed
-- or half-recorded apply leaves nothing behind and re-runs clean.
BEGIN;

-- FRESH-BOOTSTRAP fix (audit): repo 0001 carries a dead prototype-era
-- desk.ticket_links (a/b pair shape) that production never had — its 0001
-- ran before that table was added to the file. On a fresh database the
-- CREATE IF NOT EXISTS below silently no-ops against 0001's table and the
-- src_id index then aborts the whole chain (42703 under ON_ERROR_STOP),
-- killing every DR restore / new environment at 0025. Drop the legacy shape
-- when it is present, empty, and unmistakably 0001's (a/b, no src_id) —
-- production databases recorded 0025 long ago and never re-run this file.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'desk' AND table_name = 'ticket_links'
                AND column_name = 'a')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'desk' AND table_name = 'ticket_links'
                        AND column_name = 'src_id') THEN
    IF EXISTS (SELECT 1 FROM desk.ticket_links) THEN
      RAISE EXCEPTION '0025: legacy desk.ticket_links (a/b shape) holds rows — resolve by hand';
    END IF;
    DROP TABLE desk.ticket_links;
  END IF;
END $do$;

CREATE TABLE IF NOT EXISTS desk.ticket_links (
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
CREATE INDEX IF NOT EXISTS ticket_links_src_idx
  ON desk.ticket_links (src_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS ticket_links_dst_idx
  ON desk.ticket_links (dst_id) WHERE voided_at IS NULL;
-- one live parent per child:
CREATE UNIQUE INDEX IF NOT EXISTS ticket_links_one_parent
  ON desk.ticket_links (dst_id) WHERE kind = 'child' AND voided_at IS NULL;
-- one live related link per pair, either direction:
CREATE UNIQUE INDEX IF NOT EXISTS ticket_links_related_pair
  ON desk.ticket_links ((LEAST(src_id, dst_id)), (GREATEST(src_id, dst_id)))
  WHERE kind = 'related' AND voided_at IS NULL;

-- system states: written by the machine, not pickable by hand
ALTER TABLE desk.ticket_states
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

INSERT INTO desk.ticket_states (label, kind, is_core, active, position, is_system)
SELECT 'Closed: child ticket', 'done', true, true, 7, true
 WHERE NOT EXISTS (SELECT 1 FROM desk.ticket_states
                    WHERE label = 'Closed: child ticket');

COMMIT;
