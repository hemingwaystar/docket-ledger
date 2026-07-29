-- ============================================================================
-- 0011_dml_grant_audit.sql — a systematic audit of every INSERT/UPDATE/DELETE
-- in all three services against the actual grants (prompted by bug #15's
-- class: least-privilege refusing an unprovisioned path only when the path is
-- first exercised in production). Four missing grants, all designed behavior:
--
--   shared.client_domains  DELETE→desk_api   patch_client rewrites the domain
--                                            list by replace (config rows —
--                                            the audit log is the history)
--   shared.agent_groups    DELETE→desk_api   patch_agent rewrites group
--                                            membership by replace (link rows)
--   desk.project_tasks     DELETE→desk_api   remove_task on OPEN checklists
--                                            only — endpoint refuses if done
--                                            or any time is logged under it,
--                                            so no billing history can vanish
--   shared.contacts        INSERT→mail_worker the routing ladder's domain-
--                                            match auto-contact (unknown
--                                            sender @ known client domain) —
--                                            would have failed on the first
--                                            real such email
--
-- Doctrine: DELETE remains business-data-forbidden. The exceptions are now
-- sessions (0005), ticket_tags (0009), and the two replace-style link/config
-- tables + guarded open-checklist tasks here — each documented, each audited
-- at the API layer.
-- ============================================================================
BEGIN;

GRANT DELETE ON shared.client_domains TO desk_api;
GRANT DELETE ON shared.agent_groups   TO desk_api;
GRANT DELETE ON desk.project_tasks    TO desk_api;
GRANT INSERT ON shared.contacts       TO mail_worker;

COMMIT;
