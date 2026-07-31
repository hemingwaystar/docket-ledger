-- 0028_prio_color_contact_vip.sql — build 12: priority tier colors +
-- VIP contacts.
--
-- priorities.color mirrors 0027's ticket_states.color exactly: a palette
-- token (for priorities: the p1..p4 flag styles) or a "#rrggbb" hex from
-- the UI's RGB square, validated at the API; NULL = the shipped
-- rank-derived flag color, so existing rows render unchanged.
--
-- contacts.vip marks the PERSON (the customer contact on tickets). The
-- trigger engine gains a 'vip' condition field reading it through the
-- ticket's contact; the directory contact editors carry the checkbox.
-- Default false — nobody is VIP until someone says so.
--
-- Grants: desk_api's blanket DML (0001) covers both; the worker's engine
-- reads contacts via its existing shared-schema SELECT (0001). Nothing
-- else needed. Transactional + idempotent (build-8b rules).
BEGIN;

ALTER TABLE desk.priorities
  ADD COLUMN IF NOT EXISTS color text;

ALTER TABLE shared.contacts
  ADD COLUMN IF NOT EXISTS vip boolean NOT NULL DEFAULT false;

COMMIT;
