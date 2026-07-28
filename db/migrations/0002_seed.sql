-- ============================================================================
-- 0002_seed.sql — the rows the system cannot run without.
-- Client/agent/history import from Zammad is a separate, later migration.
-- ============================================================================
BEGIN;

-- sentinels (§10.13) — guarded by triggers from 0001
INSERT INTO shared.clients (name, is_sentinel, billable_default, billing_cycle)
VALUES ('Unassigned intake', true, false, 'monthly');

INSERT INTO ledger.activity_types (name, is_sentinel, billable) VALUES
  ('Unclassified', true, false);

INSERT INTO ledger.activity_types (name, billable) VALUES
  ('Remote support', true), ('Onsite', true), ('Project work', true),
  ('Consulting', true), ('Internal', false), ('Cancelled', false);

-- core ticket states (kind drives SLA clocks, pending wakes, reports)
INSERT INTO desk.ticket_states (label, kind, is_core, position) VALUES
  ('New', 'open', true, 1), ('Open', 'open', true, 2),
  ('Pending reminder', 'paused', true, 3), ('On hold', 'paused', true, 4),
  ('Solved', 'done', true, 5), ('Closed', 'done', true, 6);

INSERT INTO desk.priorities (label, rank, sla_first_response_hours, sla_resolution_hours) VALUES
  ('Low', 1, 24, 120), ('Normal', 2, 8, 48), ('High', 3, 4, 24), ('Urgent', 4, 1, 8);

-- permission catalog: mirrors the prototype matrices 1:1
INSERT INTO shared.permissions (id, app, grp, label) VALUES
  ('view_own','desk','Visibility','View own tickets'),
  ('view_group','desk','Visibility','View tickets in my groups'),
  ('view_all','desk','Visibility','View every ticket'),
  ('see_billing','desk','Visibility','See logged time & Ledger links'),
  ('create','desk','Working','Create tickets'),
  ('reply','desk','Working','Send public replies'),
  ('note','desk','Working','Add internal notes'),
  ('log_time','desk','Working','Log time (feeds the Ledger)'),
  ('verify_identity','desk','Working','Run caller verification'),
  ('assign','desk','Triage','Assign owner & move between groups'),
  ('edit_props','desk','Triage','Change state, priority & tags'),
  ('close','desk','Triage','Solve & close tickets'),
  ('view_clients','desk','Clients','View the client directory'),
  ('add_contacts','desk','Clients','Add contacts to clients'),
  ('manage_clients','desk','Clients','Edit clients & contacts'),
  ('view_projects','desk','Projects','See the Projects tab & open projects'),
  ('manage_projects','desk','Projects','Create projects, edit checklists & billing, submit for review'),
  ('approve_projects','desk','Projects','Approve reviewed projects (bills to Ledger)'),
  ('export_csv','desk','Admin','Export & copy CSV data'),
  ('manage_roles','desk','Admin','Manage roles & access'),
  ('manage_automations','desk','Admin','Manage automations & mail ingestion'),
  ('manage_settings','desk','Admin','Manage groups, SLA & channels'),
  ('view_audit','desk','Admin','View the audit log'),
  ('l_view_own','ledger','Visibility','View own time'),
  ('l_view_all','ledger','Visibility','View all technicians'' time'),
  ('l_see_amounts','ledger','Visibility','See billed rates & amounts'),
  ('l_view_clients','ledger','Clients','View client billing breakdowns'),
  ('l_all_clients','ledger','Clients','Access every client'),
  ('l_edit_own','ledger','Editing','Classify & edit own time'),
  ('l_edit_all','ledger','Editing','Edit anyone''s time'),
  ('l_submit','ledger','Editing','Submit time for review'),
  ('l_edit_submitted','ledger','Editing','Adjust submitted (pre-approval) time'),
  ('l_approve','ledger','Billing & admin','Approve timesheets & billing periods'),
  ('l_export','ledger','Billing & admin','Export approved periods'),
  ('l_manage_clients','ledger','Billing & admin','Manage client billing & access'),
  ('l_manage_types','ledger','Billing & admin','Manage activity types & rates'),
  ('l_view_audit','ledger','Billing & admin','View the Ledger audit log'),
  ('l_manage_settings','ledger','Billing & admin','Manage Ledger settings');

-- core roles + their presets
INSERT INTO shared.roles (name, note, is_core, entra_group) VALUES
  ('Admin','Configure the system; sees everything.', true, 'SG-Desk-Admins'),
  ('Dispatcher','Runs the queue and reviews time.', true, 'SG-Desk-Dispatch'),
  ('Technician','Works assigned and group tickets.', true, 'SG-Desk-Techs'),
  ('Customer','Portal access to their own tickets only (phase 2).', true, 'SG-Desk-Customers');

INSERT INTO shared.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM shared.roles r CROSS JOIN shared.permissions p
WHERE r.name = 'Admin';

INSERT INTO shared.role_permissions (role_id, permission_id)
SELECT r.id, unnest(ARRAY[
  'view_own','view_group','view_all','see_billing','create','reply','note','log_time',
  'assign','edit_props','close','view_clients','add_contacts','verify_identity',
  'export_csv','view_projects','manage_projects',
  'l_view_own','l_view_all','l_see_amounts','l_view_clients','l_edit_own','l_submit','l_edit_submitted'])
FROM shared.roles r WHERE r.name = 'Dispatcher';

INSERT INTO shared.role_permissions (role_id, permission_id)
SELECT r.id, unnest(ARRAY[
  'view_own','view_group','create','reply','note','log_time','close',
  'view_clients','add_contacts','verify_identity','view_projects',
  'l_view_own','l_view_clients','l_edit_own','l_submit'])
FROM shared.roles r WHERE r.name = 'Technician';

INSERT INTO shared.role_permissions (role_id, permission_id)
SELECT r.id, 'view_own' FROM shared.roles r WHERE r.name = 'Customer';

-- GUI-configurable defaults (everything editable in-app; NOTHING in compose)
INSERT INTO shared.app_config (key, value) VALUES
  ('auth',          '{"sso_enabled": false, "tenant": "", "client_id": "", "local_passwords": true, "role_mapping": false, "mfa": "optional"}'),
  ('graph',         '{"connected": false, "tenant": "", "client_id": "", "scopes": ["Mail.Read","Mail.Send","offline_access"]}'),
  ('verification',  '{"sms": {"enabled": false, "provider": "voipms", "did": "", "api_user": ""}, "email": {"enabled": true, "from": ""}, "ttl_min": 10, "attempts": 3, "post_to_thread": true}'),
  ('business_hours','{"days": [1,2,3,4,5], "start": "08:00", "end": "18:00"}'),
  ('odoo',          '{"enabled": false, "url": "", "db": "", "journal": "Customer Invoices", "mode": "draft"}'),
  ('retainers',     '{"enabled": false}'),
  ('projects',      '{"lock_on_approve": true}');

INSERT INTO desk.project_templates (name, tasks) VALUES
  ('Blank project', '[]'),
  ('Client onboarding', '[{"label":"Discovery & audit"},{"label":"Network & firewall setup"},{"label":"Workstation rollout"},{"label":"M365 / email migration"},{"label":"Documentation & handoff"}]'),
  ('Server migration', '[{"label":"Pre-migration audit"},{"label":"New host provisioning"},{"label":"Data migration"},{"label":"Cutover & DNS"},{"label":"Decommission & documentation"}]');

INSERT INTO audit.events (app, action, detail)
VALUES ('system', 'Database initialized', 'schemas shared/desk/ledger/audit created; sentinels, core roles and defaults seeded');

COMMIT;
