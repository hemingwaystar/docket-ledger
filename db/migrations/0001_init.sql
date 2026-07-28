-- ============================================================================
-- Hemingway Suite — 0001_init.sql
-- One shared PostgreSQL, four schemas:
--   shared : the control plane both apps read (clients, people, roles, config)
--   desk   : Docket — tickets, mail, projects, verification
--   ledger : Ledger — time, rates, periods, approvals, export
--   audit  : append-only event log (no UPDATE/DELETE grants, ever)
--
-- Design rules (from HANDOFF §10 — settled, do not relitigate):
--   * timestamptz everywhere; time entries are intervals; hours always derived
--   * money is integer cents; rates live in valid_from tables, never bare columns
--   * enum-like sets that users edit are TABLES (ticket_states, priorities,
--     activity_types); fixed machine states are CHECK constraints, documented
--   * every table that user actions mutate gets (version, updated_at) for
--     optimistic locking, bumped by trigger
--   * sentinels (catch-all client, Unclassified type) are rows guarded by
--     triggers, not app convention
--   * immutability (locked periods, manager-approved time, approved projects)
--     is enforced HERE with triggers — the APIs are a convenience layer
-- ============================================================================

BEGIN;

CREATE SCHEMA shared;
CREATE SCHEMA desk;
CREATE SCHEMA ledger;
CREATE SCHEMA audit;

-- ---------------------------------------------------------------------------
-- Common plumbing
-- ---------------------------------------------------------------------------

-- optimistic locking: bump version + updated_at on every UPDATE
CREATE FUNCTION shared.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version    := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- the acting user, set per-transaction by the APIs:
--   SET LOCAL app.actor = 'agent:<uuid>' | 'automation' | 'graph:<mailbox>'
CREATE FUNCTION shared.current_actor() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT COALESCE(NULLIF(current_setting('app.actor', true), ''), 'unknown') $$;

-- ---------------------------------------------------------------------------
-- audit: append-only. One table, richly indexed, never rewritten.
-- ---------------------------------------------------------------------------
CREATE TABLE audit.events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text        NOT NULL DEFAULT shared.current_actor(),
  app         text        NOT NULL CHECK (app IN ('desk','ledger','mail','auth','system')),
  action      text        NOT NULL,             -- 'Ticket merged', 'Timesheet approved', ...
  entity      text,                             -- 'ticket:104991', 'entry:<uuid>'
  detail      text,                             -- human-readable before→after
  data        jsonb                             -- structured payload when useful
);
CREATE INDEX events_at_idx     ON audit.events (at DESC);
CREATE INDEX events_entity_idx ON audit.events (entity);
COMMENT ON TABLE audit.events IS
  'Append-only. The migrator role owns it; runtime roles get INSERT+SELECT only.';

-- ---------------------------------------------------------------------------
-- shared: directory + auth + config + secrets
-- ---------------------------------------------------------------------------

CREATE TABLE shared.groups (                      -- ticket boards / teams
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch BEFORE UPDATE ON shared.groups
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

CREATE TABLE shared.roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  note        text NOT NULL DEFAULT '',
  is_core     boolean NOT NULL DEFAULT false,    -- Admin/Dispatcher/Technician/Customer
  active      boolean NOT NULL DEFAULT true,
  entra_group text,                              -- 'SG-Desk-Admins'; used when mapping is ON
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch BEFORE UPDATE ON shared.roles
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

-- the permission catalog is DATA so the Directory can render and grant it.
CREATE TABLE shared.permissions (
  id          text PRIMARY KEY,                  -- 'view_projects', 'approve', ...
  app         text NOT NULL CHECK (app IN ('desk','ledger')),
  grp         text NOT NULL,                     -- 'Visibility', 'Projects', ...
  label       text NOT NULL
);

CREATE TABLE shared.role_permissions (
  role_id       uuid NOT NULL REFERENCES shared.roles(id) ON DELETE CASCADE,
  permission_id text NOT NULL REFERENCES shared.permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE shared.agents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  email                 text NOT NULL UNIQUE,
  initials              text NOT NULL DEFAULT '',
  active                boolean NOT NULL DEFAULT true,
  -- role: authoritative when Entra role-mapping is OFF; preview-only when ON
  role_id               uuid REFERENCES shared.roles(id),
  entra_object_id       text UNIQUE,             -- set on first SSO sign-in
  -- local auth (feature-flagged via shared.app_config 'auth')
  password_hash         text,                    -- argon2id; NULL = SSO only
  password_must_change  boolean NOT NULL DEFAULT false,
  totp_secret_enc       bytea,                   -- envelope-encrypted; NULL = MFA not set
  totp_enrolled_at      timestamptz,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch BEFORE UPDATE ON shared.agents
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

CREATE TABLE shared.agent_groups (
  agent_id uuid NOT NULL REFERENCES shared.agents(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES shared.groups(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, group_id)
);

CREATE TABLE shared.clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,
  is_sentinel   boolean NOT NULL DEFAULT false,  -- the one catch-all intake row
  archived_at   timestamptz,
  billing_cycle text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('weekly','monthly')),
  billable_default boolean NOT NULL DEFAULT true, -- sentinel seeds FALSE
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch BEFORE UPDATE ON shared.clients
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

-- sentinel client can never be archived; nothing deletes clients (archive-first)
CREATE FUNCTION shared.guard_sentinel_client() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'clients are archive-first; deletion is not allowed';
  END IF;
  IF OLD.is_sentinel AND NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'the catch-all intake client cannot be archived';
  END IF;
  IF OLD.is_sentinel <> NEW.is_sentinel THEN
    RAISE EXCEPTION 'is_sentinel is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_sentinel BEFORE UPDATE OR DELETE ON shared.clients
  FOR EACH ROW EXECUTE FUNCTION shared.guard_sentinel_client();

CREATE TABLE shared.client_domains (              -- routing ladder step 2
  client_id uuid NOT NULL REFERENCES shared.clients(id) ON DELETE CASCADE,
  domain    text NOT NULL,
  PRIMARY KEY (client_id, domain)
);
CREATE UNIQUE INDEX client_domains_domain_key ON shared.client_domains (lower(domain));

CREATE TABLE shared.contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES shared.clients(id),
  name        text NOT NULL,
  email       text NOT NULL,
  title       text NOT NULL DEFAULT '',
  department  text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  mobile      text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  is_portal_user boolean NOT NULL DEFAULT false, -- schema affordance; portal is phase 2
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_email_key ON shared.contacts (lower(email));
CREATE TRIGGER touch BEFORE UPDATE ON shared.contacts
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

-- GUI-configurable settings: documented keys, one row each, jsonb value.
-- Keys: 'auth' (sso/local/mfa/role-mapping), 'graph' (tenant/client-id/consent),
--       'verification' (sms/email/ttl/attempts), 'business_hours', 'odoo',
--       'retainers' ({enabled: bool}), 'sla_policy'
CREATE TABLE shared.app_config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT shared.current_actor()
);
CREATE TRIGGER touch BEFORE UPDATE ON shared.app_config
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

CREATE TABLE shared.business_holidays (
  day   date PRIMARY KEY,
  label text NOT NULL DEFAULT ''
);

-- secrets: envelope-encrypted with the file-mounted KEK (see secrets/README).
-- The API is write-only: runtime roles may INSERT/UPDATE ciphertext and read
-- metadata; plaintext never leaves the service that decrypts it.
CREATE TABLE shared.secrets (
  name        text PRIMARY KEY,                  -- 'entra_oidc', 'graph', 'voipms', 'twilio'
  ciphertext  bytea NOT NULL,
  nonce       bytea NOT NULL,
  kek_id      text  NOT NULL,                    -- which mounted key encrypted it
  rotated_at  timestamptz NOT NULL DEFAULT now(),
  rotated_by  text NOT NULL DEFAULT shared.current_actor()
);

CREATE TABLE shared.api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label        text NOT NULL,
  token_hash   text NOT NULL UNIQUE,             -- sha256; plaintext shown once
  scopes       text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES shared.agents(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- one-time verification codes: salted-hash stored, TTL + attempt caps from
-- app_config('verification'); destination is ALWAYS the stored contact record
CREATE TABLE desk.verification_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   bigint NOT NULL,                   -- FK added after desk.tickets
  contact_id  uuid NOT NULL REFERENCES shared.contacts(id),
  channel     text NOT NULL CHECK (channel IN ('sms','email')),
  code_hash   text NOT NULL,
  salt        text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- desk: ticketing
-- ---------------------------------------------------------------------------

CREATE TABLE desk.ticket_states (                 -- user-editable in Settings
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label    text NOT NULL UNIQUE,
  kind     text NOT NULL CHECK (kind IN ('open','paused','done')),  -- drives SLA/pending/reports
  is_core  boolean NOT NULL DEFAULT false,
  active   boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0
);

CREATE TABLE desk.priorities (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label    text NOT NULL UNIQUE,
  rank     integer NOT NULL UNIQUE,               -- higher = more urgent
  active   boolean NOT NULL DEFAULT true,
  sla_first_response_hours numeric(6,2) NOT NULL, -- business hours
  sla_resolution_hours     numeric(6,2) NOT NULL
);

CREATE TABLE desk.tickets (
  id             bigint GENERATED ALWAYS AS IDENTITY (START WITH 100000) PRIMARY KEY,
  title          text NOT NULL,
  client_id      uuid NOT NULL REFERENCES shared.clients(id),
  contact_id     uuid REFERENCES shared.contacts(id),
  group_id       uuid NOT NULL REFERENCES shared.groups(id),
  owner_id       uuid REFERENCES shared.agents(id),
  state_id       uuid NOT NULL REFERENCES desk.ticket_states(id),
  priority_id    uuid NOT NULL REFERENCES desk.priorities(id),
  pending_until  timestamptz,                     -- scheduler wakes + reopens
  first_reply_at timestamptz,                     -- stops the first-response SLA clock
  merged_into_id bigint REFERENCES desk.tickets(id),
  cc             text[] NOT NULL DEFAULT '{}',
  is_project     boolean NOT NULL DEFAULT false,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_client_idx  ON desk.tickets (client_id);
CREATE INDEX tickets_state_idx   ON desk.tickets (state_id);
CREATE INDEX tickets_owner_idx   ON desk.tickets (owner_id);
CREATE INDEX tickets_pending_idx ON desk.tickets (pending_until) WHERE pending_until IS NOT NULL;
CREATE TRIGGER touch BEFORE UPDATE ON desk.tickets
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

ALTER TABLE desk.verification_codes
  ADD CONSTRAINT verification_ticket_fk FOREIGN KEY (ticket_id) REFERENCES desk.tickets(id);

CREATE TABLE desk.ticket_tags (
  ticket_id bigint NOT NULL REFERENCES desk.tickets(id) ON DELETE CASCADE,
  tag       text NOT NULL,
  PRIMARY KEY (ticket_id, tag)
);
CREATE INDEX ticket_tags_tag_idx ON desk.ticket_tags (tag);

CREATE TABLE desk.articles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   bigint NOT NULL REFERENCES desk.tickets(id),
  kind        text NOT NULL CHECK (kind IN ('mail_in','reply','note','sys')),
  author      text NOT NULL,                      -- display name; agents also FK below
  author_id   uuid REFERENCES shared.agents(id),
  mail_from   text,
  mail_to     text,
  mail_cc     text[],
  message_id  text,                               -- Message-ID threading
  in_reply_to text,
  body        text NOT NULL,
  is_auto     boolean NOT NULL DEFAULT false,     -- Auto-Submitted / trigger output
  sent_at     timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX articles_ticket_idx ON desk.articles (ticket_id, sent_at);
CREATE UNIQUE INDEX articles_message_id_key ON desk.articles (message_id)
  WHERE message_id IS NOT NULL;                   -- ingestion idempotency

-- sent bodies are immutable; notes may be edited (kind='note' only)
CREATE FUNCTION desk.guard_article_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind <> 'note' AND NEW.body IS DISTINCT FROM OLD.body THEN
    RAISE EXCEPTION 'sent article bodies are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_immutable BEFORE UPDATE ON desk.articles
  FOR EACH ROW EXECUTE FUNCTION desk.guard_article_immutability();

CREATE TABLE desk.attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  uuid NOT NULL REFERENCES desk.articles(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  mime_type   text NOT NULL,
  byte_size   integer NOT NULL,
  content     bytea NOT NULL,   -- bytea keeps backups atomic at MSP scale (reviewed decision)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE desk.ticket_links (
  a bigint NOT NULL REFERENCES desk.tickets(id) ON DELETE CASCADE,
  b bigint NOT NULL REFERENCES desk.tickets(id) ON DELETE CASCADE,
  PRIMARY KEY (a, b),
  CHECK (a < b)                                   -- one row per pair
);

-- mail plumbing (mail-worker)
CREATE TABLE desk.mailboxes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address       text NOT NULL UNIQUE,
  display_name  text NOT NULL DEFAULT '',
  group_id      uuid NOT NULL REFERENCES shared.groups(id),  -- board filing + GROUP_SENDAS
  default_priority_id uuid REFERENCES desk.priorities(id),
  paused        boolean NOT NULL DEFAULT false,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch BEFORE UPDATE ON desk.mailboxes
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

CREATE TABLE desk.graph_subscriptions (
  mailbox_id   uuid PRIMARY KEY REFERENCES desk.mailboxes(id) ON DELETE CASCADE,
  subscription_id text NOT NULL,
  expires_at   timestamptz NOT NULL,              -- renewal job; delta-poll is the backstop
  last_delta_at timestamptz
);

-- mail rules + event triggers: conds/actions are jsonb by design — the builder
-- UI owns their shape; the engine validates. Recursion guard: run depth.
CREATE TABLE desk.automation_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('mail_rule','trigger')),
  event      text CHECK (event IN ('create','followup','state_change')),  -- triggers only
  enabled    boolean NOT NULL DEFAULT true,
  conditions jsonb NOT NULL DEFAULT '[]',
  actions    jsonb NOT NULL DEFAULT '[]',
  runs       bigint NOT NULL DEFAULT 0,
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch BEFORE UPDATE ON desk.automation_rules
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

CREATE TABLE desk.round_robin_cursors (           -- autoassign state per group
  group_id     uuid PRIMARY KEY REFERENCES shared.groups(id) ON DELETE CASCADE,
  last_agent_id uuid REFERENCES shared.agents(id)
);

CREATE TABLE desk.canned_responses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  body       text NOT NULL,                       -- #{customer.name} etc render at insert
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch BEFORE UPDATE ON desk.canned_responses
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

CREATE TABLE desk.signatures (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind text NOT NULL CHECK (owner_kind IN ('agent','group')),
  agent_id  uuid REFERENCES shared.agents(id) ON DELETE CASCADE,
  group_id  uuid REFERENCES shared.groups(id) ON DELETE CASCADE,
  body      text NOT NULL,
  CHECK ( (owner_kind='agent' AND agent_id IS NOT NULL AND group_id IS NULL)
       OR (owner_kind='group' AND group_id IS NOT NULL AND agent_id IS NULL) )
);

-- ---------------------------------------------------------------------------
-- desk: projects (checklist-driven tickets)
-- ---------------------------------------------------------------------------
CREATE TABLE desk.projects (
  ticket_id     bigint PRIMARY KEY REFERENCES desk.tickets(id),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','review','approved')),
  billing_model text NOT NULL DEFAULT 'per_task' CHECK (billing_model IN ('per_task','project_flat')),
  project_flat_cents integer CHECK (project_flat_cents IS NULL OR project_flat_cents >= 0),
  template      text,
  unlocked      boolean NOT NULL DEFAULT false,   -- admin unlock: ticket editable, billing stays frozen
  submitted_at  timestamptz, submitted_by uuid REFERENCES shared.agents(id),
  approved_at   timestamptz, approved_by  uuid REFERENCES shared.agents(id),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch BEFORE UPDATE ON desk.projects
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

CREATE TABLE desk.project_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   bigint NOT NULL REFERENCES desk.projects(ticket_id) ON DELETE CASCADE,
  label       text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  done_at     timestamptz,
  done_by     uuid REFERENCES shared.agents(id),
  billing_mode text NOT NULL DEFAULT 'hourly' CHECK (billing_mode IN ('hourly','flat')),
  rate_cents  integer CHECK (rate_cents IS NULL OR rate_cents >= 0),   -- hourly override; NULL = ladder
  flat_cents  integer CHECK (flat_cents IS NULL OR flat_cents >= 0),
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_tasks_ticket_idx ON desk.project_tasks (ticket_id, position);

CREATE TABLE desk.project_templates (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name   text NOT NULL UNIQUE,
  tasks  jsonb NOT NULL DEFAULT '[]'              -- [{label, billing_mode}]
);

-- once approved (and not admin-unlocked), tasks and project billing are frozen
CREATE FUNCTION desk.guard_approved_project() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proj desk.projects;
BEGIN
  SELECT * INTO proj FROM desk.projects WHERE ticket_id =
    COALESCE(NEW.ticket_id, OLD.ticket_id);
  IF proj.status = 'approved' THEN
    RAISE EXCEPTION 'project #% is approved — checklist and billing are frozen', proj.ticket_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER guard_frozen_tasks BEFORE INSERT OR UPDATE OR DELETE ON desk.project_tasks
  FOR EACH ROW EXECUTE FUNCTION desk.guard_approved_project();

CREATE FUNCTION desk.guard_approved_project_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- unlock/relock and nothing else may change after approval
  IF OLD.status = 'approved' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.billing_model IS DISTINCT FROM OLD.billing_model
    OR NEW.project_flat_cents IS DISTINCT FROM OLD.project_flat_cents
  ) THEN
    RAISE EXCEPTION 'approved project billing is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_frozen_project BEFORE UPDATE ON desk.projects
  FOR EACH ROW EXECUTE FUNCTION desk.guard_approved_project_row();

-- ---------------------------------------------------------------------------
-- ledger: time, rates, periods, approvals
-- ---------------------------------------------------------------------------

CREATE TABLE ledger.activity_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  is_sentinel boolean NOT NULL DEFAULT false,     -- 'Unclassified'
  billable    boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch BEFORE UPDATE ON ledger.activity_types
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

CREATE FUNCTION ledger.guard_sentinel_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'activity types are archive-first'; END IF;
  IF OLD.is_sentinel AND (NEW.active = false OR NEW.billable = true) THEN
    RAISE EXCEPTION 'the Unclassified sentinel stays active and non-billable';
  END IF;
  IF OLD.is_sentinel <> NEW.is_sentinel THEN RAISE EXCEPTION 'is_sentinel is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_sentinel BEFORE UPDATE OR DELETE ON ledger.activity_types
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_sentinel_type();

-- RATES: three effective-dated tables — never a bare rate column.
-- Resolution ladder (highest wins), by entry started_at:
--   project task override (desk.project_tasks.rate_cents, once project approved)
--   > ticket override > client+type > client-wide > activity type base
CREATE TABLE ledger.activity_type_rates (
  activity_type_id uuid NOT NULL REFERENCES ledger.activity_types(id) ON DELETE CASCADE,
  valid_from       date NOT NULL,
  rate_cents       integer NOT NULL CHECK (rate_cents >= 0),
  PRIMARY KEY (activity_type_id, valid_from)      -- same-day edits collapse to one row
);

CREATE TABLE ledger.client_rates (
  client_id        uuid NOT NULL REFERENCES shared.clients(id) ON DELETE CASCADE,
  activity_type_id uuid REFERENCES ledger.activity_types(id) ON DELETE CASCADE,
  valid_from       date NOT NULL,
  rate_cents       integer CHECK (rate_cents IS NULL OR rate_cents >= 0),
  billable         boolean,                       -- NULL = inherit from type
  PRIMARY KEY (client_id, valid_from, activity_type_id)
);
COMMENT ON TABLE ledger.client_rates IS
  'activity_type_id NULL = client-wide override; non-NULL = client+type override.';

CREATE TABLE ledger.ticket_rates (
  ticket_id  bigint NOT NULL REFERENCES desk.tickets(id) ON DELETE CASCADE,
  valid_from date NOT NULL,
  rate_cents integer NOT NULL CHECK (rate_cents >= 0),
  PRIMARY KEY (ticket_id, valid_from)
);

CREATE TABLE ledger.billing_periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES shared.clients(id),
  period_key  text NOT NULL,                      -- '2026-07' / '2026-W30' from client cycle
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','exported')),
  approved_at timestamptz, approved_by uuid REFERENCES shared.agents(id),
  exported_at timestamptz, export_ref text,       -- Odoo draft-invoice reference
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, period_key)
);
CREATE TRIGGER touch BEFORE UPDATE ON ledger.billing_periods
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

-- state machine: open → approved → exported, one-way
CREATE FUNCTION ledger.guard_period_states() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' AND NEW.status = 'open' THEN
    RAISE EXCEPTION 'approved periods cannot reopen';
  END IF;
  IF OLD.status = 'exported' AND NEW.status <> 'exported' THEN
    RAISE EXCEPTION 'exported periods are terminal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_states BEFORE UPDATE ON ledger.billing_periods
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_period_states();

CREATE TABLE ledger.time_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_eid    text UNIQUE,                      -- Docket ingestion idempotency (§10.9)
  ticket_id     bigint REFERENCES desk.tickets(id),
  task_id       uuid REFERENCES desk.project_tasks(id),
  client_id     uuid NOT NULL REFERENCES shared.clients(id),
  tech_id       uuid NOT NULL REFERENCES shared.agents(id),
  activity_type_id uuid NOT NULL REFERENCES ledger.activity_types(id),
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz NOT NULL,
  hours         numeric(8,2) GENERATED ALWAYS AS
                (round(EXTRACT(epoch FROM (ended_at - started_at)) / 3600.0, 2)) STORED,
  note          text NOT NULL DEFAULT '',
  period_id     uuid REFERENCES ledger.billing_periods(id),  -- assigned on write from client cycle
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','void')),
  voided_at     timestamptz, void_reason text,
  -- tech submission → manager (timesheet) approval → period lock
  submitted_at  timestamptz,
  ts_approved_at timestamptz, ts_approved_by uuid REFERENCES shared.agents(id),
  returned_at   timestamptz,  returned_by  uuid REFERENCES shared.agents(id),
  return_reason text,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at > started_at)                   -- overnight spans legal; zero/negative not
);
CREATE INDEX time_entries_ticket_idx ON ledger.time_entries (ticket_id);
CREATE INDEX time_entries_tech_idx   ON ledger.time_entries (tech_id, started_at);
CREATE INDEX time_entries_period_idx ON ledger.time_entries (period_id);
CREATE TRIGGER touch BEFORE UPDATE ON ledger.time_entries
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

-- immutability ladder, enforced at the DB:
--   * entries in an approved/exported period: no changes at all, no deletes ever
--   * manager-approved (ts_approved) entries: only void (removed-in-Docket) or
--     approval revocation may touch them
--   * nothing is ever DELETEd — voids only
CREATE FUNCTION ledger.guard_entry_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pstatus text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'time entries are never deleted — void them';
  END IF;
  SELECT bp.status INTO pstatus FROM ledger.billing_periods bp WHERE bp.id = OLD.period_id;
  IF pstatus IN ('approved','exported') THEN
    RAISE EXCEPTION 'entry belongs to a % period — immutable', pstatus;
  END IF;
  IF OLD.ts_approved_at IS NOT NULL
     AND NEW.ts_approved_at IS NOT DISTINCT FROM OLD.ts_approved_at  -- not a revocation
     AND NEW.status = OLD.status THEN                                -- not a void
    IF row(NEW.started_at, NEW.ended_at, NEW.activity_type_id, NEW.task_id, NEW.note, NEW.tech_id)
       IS DISTINCT FROM
       row(OLD.started_at, OLD.ended_at, OLD.activity_type_id, OLD.task_id, OLD.note, OLD.tech_id) THEN
      RAISE EXCEPTION 'manager-approved entry is frozen — revoke the timesheet approval first';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_immutable BEFORE UPDATE OR DELETE ON ledger.time_entries
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_entry_immutability();

-- project time must sit under a task of ITS OWN project
CREATE FUNCTION ledger.guard_project_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ticket_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM desk.projects p WHERE p.ticket_id = NEW.ticket_id) THEN
    IF NEW.task_id IS NULL THEN
      RAISE EXCEPTION 'entries on project ticket #% need a task_id', NEW.ticket_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM desk.project_tasks t
                   WHERE t.id = NEW.task_id AND t.ticket_id = NEW.ticket_id) THEN
      RAISE EXCEPTION 'task % does not belong to project #%', NEW.task_id, NEW.ticket_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_task BEFORE INSERT OR UPDATE ON ledger.time_entries
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_project_task();

CREATE TABLE ledger.retainers (                   -- feature-flagged: app_config('retainers')
  client_id      uuid PRIMARY KEY REFERENCES shared.clients(id) ON DELETE CASCADE,
  included_hours numeric(8,2) NOT NULL CHECK (included_hours >= 0),
  overage_rate_cents integer NOT NULL CHECK (overage_rate_cents >= 0),
  rollover_cap_hours numeric(8,2) NOT NULL DEFAULT 0,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch BEFORE UPDATE ON ledger.retainers
  FOR EACH ROW EXECUTE FUNCTION shared.touch_row();

-- the pricing ladder as ONE readable function: the single source of truth the
-- APIs, exports and reports all call. Project-flat coverage → amount 0 rows;
-- the project fee itself bills via ledger.project_flat_lines below.
CREATE FUNCTION ledger.priced(entry ledger.time_entries)
RETURNS TABLE (rate_cents integer, amount_cents integer, billable boolean, covered_by_project_flat boolean)
LANGUAGE sql STABLE AS $$
  WITH proj AS (
    SELECT p.billing_model, p.status,
           t.billing_mode AS task_mode, t.rate_cents AS task_rate
    FROM desk.projects p
    LEFT JOIN desk.project_tasks t ON t.id = entry.task_id
    WHERE p.ticket_id = entry.ticket_id AND p.status = 'approved'
  ),
  ladder AS (
    SELECT COALESCE(
      (SELECT task_rate FROM proj WHERE task_mode = 'hourly' AND task_rate IS NOT NULL),
      (SELECT r.rate_cents FROM ledger.ticket_rates r
        WHERE r.ticket_id = entry.ticket_id AND r.valid_from <= entry.started_at::date
        ORDER BY r.valid_from DESC LIMIT 1),
      (SELECT r.rate_cents FROM ledger.client_rates r
        WHERE r.client_id = entry.client_id AND r.activity_type_id = entry.activity_type_id
          AND r.valid_from <= entry.started_at::date ORDER BY r.valid_from DESC LIMIT 1),
      (SELECT r.rate_cents FROM ledger.client_rates r
        WHERE r.client_id = entry.client_id AND r.activity_type_id IS NULL
          AND r.valid_from <= entry.started_at::date ORDER BY r.valid_from DESC LIMIT 1),
      (SELECT r.rate_cents FROM ledger.activity_type_rates r
        WHERE r.activity_type_id = entry.activity_type_id
          AND r.valid_from <= entry.started_at::date ORDER BY r.valid_from DESC LIMIT 1),
      0) AS rate_cents
  ),
  flags AS (
    SELECT
      EXISTS (SELECT 1 FROM proj WHERE billing_model = 'project_flat'
              UNION ALL SELECT 1 FROM proj WHERE task_mode = 'flat') AS covered,
      (SELECT NOT at.is_sentinel AND COALESCE(
          (SELECT cr.billable FROM ledger.client_rates cr
            WHERE cr.client_id = entry.client_id AND cr.activity_type_id = entry.activity_type_id
              AND cr.billable IS NOT NULL AND cr.valid_from <= entry.started_at::date
            ORDER BY cr.valid_from DESC LIMIT 1),
          at.billable)
        FROM ledger.activity_types at WHERE at.id = entry.activity_type_id) AS type_billable
  )
  SELECT
    l.rate_cents,
    CASE WHEN entry.status = 'void' OR f.covered OR NOT f.type_billable THEN 0
         ELSE round(entry.hours * l.rate_cents)::integer END,
    f.type_billable AND NOT f.covered,
    f.covered
  FROM ladder l, flags f;
$$;

-- flat project fees billing into the period that contains the approval
CREATE VIEW ledger.project_flat_lines AS
SELECT p.ticket_id,
       tk.client_id,
       tk.title AS project_title,
       CASE WHEN p.billing_model = 'project_flat' THEN 'Project flat rate' ELSE t.label END AS line_label,
       CASE WHEN p.billing_model = 'project_flat' THEN p.project_flat_cents ELSE t.flat_cents END AS amount_cents,
       p.approved_at
FROM desk.projects p
JOIN desk.tickets tk ON tk.id = p.ticket_id
LEFT JOIN desk.project_tasks t
       ON p.billing_model = 'per_task' AND t.ticket_id = p.ticket_id AND t.billing_mode = 'flat'
WHERE p.status = 'approved'
  AND CASE WHEN p.billing_model = 'project_flat'
           THEN p.project_flat_cents ELSE t.flat_cents END > 0;
COMMENT ON VIEW ledger.project_flat_lines IS
  'One row per flat fee. ledger-api maps approved_at → the client-cycle period.';

CREATE TABLE ledger.odoo_exports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id  uuid NOT NULL REFERENCES ledger.billing_periods(id),
  export_ref text NOT NULL,
  payload    jsonb NOT NULL,                      -- exactly what was sent (draft invoice)
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- runtime roles + grants: the segmentation story.
--   desk_api    : owns desk.*, reads shared.*, reads ledger entries (display),
--                 writes shared directory (it hosts the control plane)
--   ledger_api  : owns ledger.*, reads shared.* + desk tickets/projects/tasks
--   mail_worker : inserts desk mail artifacts, reads shared + secrets
--   all         : INSERT+SELECT on audit.events — never UPDATE/DELETE
-- Passwords come from mounted secret files (see compose), never from SQL.
-- ---------------------------------------------------------------------------
CREATE ROLE desk_api    NOINHERIT LOGIN;
CREATE ROLE ledger_api  NOINHERIT LOGIN;
CREATE ROLE mail_worker NOINHERIT LOGIN;

GRANT USAGE ON SCHEMA shared, desk, ledger, audit TO desk_api, ledger_api, mail_worker;

GRANT SELECT, INSERT, UPDATE          ON ALL TABLES IN SCHEMA shared TO desk_api;
GRANT SELECT                          ON ALL TABLES IN SCHEMA shared TO ledger_api, mail_worker;
GRANT UPDATE (last_used_at)           ON shared.api_tokens           TO ledger_api;
GRANT SELECT, INSERT, UPDATE          ON ALL TABLES IN SCHEMA desk   TO desk_api;
GRANT SELECT                          ON desk.tickets, desk.projects, desk.project_tasks TO ledger_api;
GRANT SELECT, INSERT                  ON desk.articles, desk.attachments TO mail_worker;
GRANT SELECT, UPDATE                  ON desk.tickets, desk.mailboxes, desk.graph_subscriptions,
                                         desk.automation_rules, desk.round_robin_cursors TO mail_worker;
GRANT INSERT                          ON desk.tickets, desk.ticket_tags TO mail_worker;
GRANT SELECT                          ON desk.ticket_states, desk.priorities, desk.canned_responses,
                                         desk.signatures TO mail_worker;
GRANT SELECT, INSERT, UPDATE          ON ALL TABLES IN SCHEMA ledger TO ledger_api;
GRANT SELECT, INSERT                  ON ledger.time_entries TO desk_api;     -- Docket logs time
GRANT UPDATE                          ON ledger.time_entries TO desk_api;     -- edits (triggers gate)
GRANT SELECT                          ON ledger.activity_types TO desk_api, mail_worker;
GRANT INSERT, SELECT                  ON audit.events TO desk_api, ledger_api, mail_worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA desk, ledger, audit, shared TO desk_api, ledger_api, mail_worker;
-- DELETE is granted NOWHERE. Voids and archives only.

COMMIT;
