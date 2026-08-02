# Build 15 — design contract (2026-08-02)

User ask: "assign multiple techs to one ticket, keep the owner as is where
only one person can own." Product decision (asked + answered): an assigned
tech gains visibility AND the ticket appears in their "Mine"/"Assigned to
me" views — full collaboration, not label-only.

## Data (migration 0032)

`desk.ticket_assignees` — a membership join, same shape as
`shared.agent_groups`: (ticket_id bigint → desk.tickets ON DELETE CASCADE,
agent_id uuid → shared.agents, added_at, added_by, PK (ticket_id,
agent_id)) + a secondary index on agent_id for the reverse "assigned to
me" lookup. ticket_id is **bigint** (desk.tickets.id is bigint identity —
the contract's "uuid" was wrong and the implementer correctly rejected
it). Grants: 0005's ALTER DEFAULT PRIVILEGES already covers
SELECT/INSERT/UPDATE for desk_api on new desk tables; **DELETE is granted
explicitly**, mirroring 0011's agent_groups grant — a membership join
legitimately DELETEs on full-list replace (the no-DELETE doctrine guards
business records, not membership).

## Backend

`PUT /api/tickets/{id}/assignees` (write.py) — full-replace of the
assignee set, `auth.need('assign')`, one audit line + one system article
on the ticket. It **never reads or bumps `tickets.version`** and never
touches the tickets row, so it structurally cannot raise the
optimistic-lock 409 (the "Version conflict" class). Unknown/inactive
agent ids are skipped, and the endpoint returns the authoritative applied
set `{ok, assignees:[...]}`. Bootstrap emits `assigneeIds:[...]` as a
per-ticket FIELD (always present, [] when none) — the desk bootstrap key
count is unchanged.

## Frontend

- One `isMine(t)` helper in state.js: `ownerId===meId || assigneeIds
  includes meId`. Routed through **all four** owner-based "mine" sites so
  they can't drift: ticketVisible's view_own branch, the queue
  overview-def scope, the qf scope filter, the dashboard "Assigned to me"
  tile. (The two owner-only *rename* gates and the "unassigned" tests are
  intentionally left as owner checks.)
- mapIn defaults `t.assigneeIds` to [] so a pre-0032 payload can't crash.
- props.js "Assigned techs" multiCombo under Owner, `setAssignees`
  modeled on setAgentGroups (fkey-prefix slice, diff-guard, optimistic +
  render, PUT, oops on failure) — plus a success-path reconcile against
  the server's returned set so a silently-skipped inactive id doesn't
  linger. Owner select is separate and unchanged.

## Verification

2 implementers (disjoint files) → 2 adversarial verifiers over the
grant/bootstrap/scope seams + a Python/SQL parse auditor (no local
interpreter). Verifiers confirmed: migration grants sufficient (migrate
runs as the owning role, so 0005 defaults + explicit DELETE both land),
full-replace correctness, no version-conflict path, bootstrap [] default
correct with no GROUP-BY drop, and all four isMine sites converted.
Server does NOT enforce ticket-read visibility (pre-existing — every
session already receives all tickets in bootstrap; assignee visibility is
the client un-hiding its own ticket, exactly as owner visibility already
works). One minor finding (success-path reconcile) fixed pre-push.
Behavioral checks in headless Edge: isMine matrix, the PUT shape,
optimistic→reconcile drop of a skipped id, and the diff-guard all pass.
Deploy: 0032 migrate before desk-api rebuilds (deploy.sh order); reload
app tabs.
