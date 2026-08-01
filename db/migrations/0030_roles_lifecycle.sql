-- ============================================================================
-- 0030_roles_lifecycle.sql — roles gain a real lifecycle: archive/restore
-- (the shared.roles.active flag has existed since 0001 — the API finally
-- drives it) and HARD DELETE, the one user-approved exception to the
-- no-DELETE doctrine. Rationale (user, build 13): roles hold no immutable
-- business data — the permission matrix is config, membership lives on
-- shared.agents.role_id, and every role change is already narrated in
-- audit.events. Everything a deleted role ever did remains reconstructable
-- from the audit trail.
--
-- Invariants live in the database (house rule), so the guard is a trigger,
-- not just API courtesy:
--   * core roles (Admin/Dispatcher/Technician/Customer — is_core, 0002)
--     can never be deleted; bootstrap, presets and docs key on them.
--   * a role still held by ANY agent — active OR deactivated — cannot be
--     deleted. Deactivated agents keep their role_id so re-adding the same
--     email revives them intact (directory.py create_agent); deleting the
--     role out from under that would corrupt the revival path. Reassign via
--     PATCH /api/directory/agents/{email} first (helpers.agent matches
--     deactivated agents too).
-- Backstops if the trigger is ever bypassed: shared.agents.role_id has no
-- ON DELETE action (0001) so the FK still refuses; role_permissions rows
-- vanish with their role via 0001's ON DELETE CASCADE (no grant needed —
-- FK cascades run with the table owner's rights; desk_api holds DELETE on
-- role_permissions since 0017 regardless).
--
-- Grant doctrine (0011): DELETE stays business-data-forbidden. The
-- exceptions are now sessions (0005), ticket_tags (0009), the replace-style
-- link/config tables + guarded open-checklist tasks (0011),
-- role_permissions (0017), and — user-approved, guarded, audited at the API
-- layer — shared.roles here. Archive/restore needs no new grant (UPDATE on
-- shared.* was granted in 0001).
--
-- Numbering (build-13 coordination): 0029 is the billing-rates migration,
-- this file is 0030, the era-guard cleanup ships as 0031 — the migrate
-- runner applies files in name order, exactly once each.
-- Transactional + idempotent (post-exit-3 rules, build 8b).
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION shared.guard_role_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE holders integer;
BEGIN
  IF OLD.is_core THEN
    RAISE EXCEPTION 'core roles cannot be deleted';
  END IF;
  SELECT count(*) INTO holders FROM shared.agents WHERE role_id = OLD.id;
  IF holders > 0 THEN
    RAISE EXCEPTION 'role "%" is still held by % agent(s) — deactivated agents count; reassign them first',
      OLD.name, holders;
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS guard_delete ON shared.roles;
CREATE TRIGGER guard_delete BEFORE DELETE ON shared.roles
  FOR EACH ROW EXECUTE FUNCTION shared.guard_role_delete();

GRANT DELETE ON shared.roles TO desk_api;

INSERT INTO audit.events (app, action, detail)
VALUES ('system', 'Migration 0030',
        'roles lifecycle: archive/restore driven by shared.roles.active; guarded hard delete granted to desk_api — user-approved exception to no-DELETE, roles only');

COMMIT;
