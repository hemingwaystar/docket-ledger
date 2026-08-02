# Build 16 — design contract (2026-08-02)

User ask: "a new bar next to [the props panel] called Schedules that holds
tech schedules and applies to the on-hold statuses." Decisions (asked +
answered): each entry is a per-tech time block (tech + start + end +
note); at the earliest scheduled start the ticket auto-resumes off hold;
Schedules REPLACES the single Wake-up field.

## Data (migration 0033)

`desk.ticket_schedules` — (id bigint IDENTITY PK, ticket_id bigint →
desk.tickets ON DELETE CASCADE, agent_id uuid → shared.agents, starts_at
timestamptz NOT NULL, ends_at timestamptz, note text, created_at,
created_by) + indexes on ticket_id and agent_id. GRANT SELECT/INSERT/
DELETE to desk_api (DELETE mirrors the 0011/0032 child-row precedent). No
explicit identity-sequence grant needed (IDENTITY sequences advance via
the identity mechanism, not caller privilege — desk.tickets is the
precedent — and 0005's default privileges cover it anyway).

## The wake integration (no worker changes)

The mail-worker's `wake_pending()` already reopens any ticket at
`desk.tickets.pending_until <= now()`. So Schedules drives resume purely
by keeping pending_until in sync: after every add/remove, `_sync_pending`
sets pending_until = `MIN(starts_at) WHERE starts_at > now()` (NULL if
none). A purely-past block therefore never sets a past pending_until (no
instant reopen); removing the earliest rolls it forward; removing the last
NULLs it. **services/mail-worker/** is untouched.**

## Backend endpoints (write.py)

`POST /api/tickets/{id}/schedules` {agent_id, starts_at(ISO), ends_at,
note} and `DELETE /api/tickets/{id}/schedules/{schedule_id}` — both
auth.need('assign'), refuse_if_locked_project, `_sane_span` on the times
(bug #27), one audit line, a sys article on add, active-agent validation
(422), DELETE idempotent + ticket-scoped. They write pending_until with NO
version predicate (can't raise the 409). **But the tickets `touch` trigger
bumps `version` on that UPDATE, so `_sync_pending` RETURNs the new version
and both endpoints return it** — the UI syncs it so a later property edit
doesn't 409 (verifier finding F1, fixed pre-push). Timestamps are epoch ms
everywhere (bootstrap, responses, pending_until) — matches the codebase
and the frontend's fmtDT/dtLocalVal/checkPendingWakes.

## Frontend

- mapIn defaults `t.schedules` to [].
- props.js: Wake-up field + setPendingUntil REMOVED (dtLocalVal kept);
  renderSchedules(t) (a .props-styled bar) + addSchedule/removeSchedule
  (optimistic + POST/DELETE + reconcileSched of schedules, pendingUntil,
  AND version + oops), schedMs normalizer.
- tickets.js viewTicket: renders the bar next to props (order
  main|schedules|props via a `.tk-layout.has-sched` 3rd column) ONLY when
  the state kind is 'paused'.
- desk.css: `.tk-layout.has-sched` 3-column; the ≤1000px media query still
  collapses to stacked.

## Verification

2 implementers (disjoint files) → 2 adversarial verifiers + a Python/SQL
auditor. One major finding (F1: the pending_until UPDATE bumps version via
the touch trigger → spurious 409 on the next edit) fixed by returning and
syncing the version. Behavioral checks in headless Edge: paused-only
gating, reconcile of schedules/pendingUntil/version, past-block exclusion,
schedMs ISO+ms normalization — all pass. Deploy: 0033 migrates before
desk-api rebuilds (deploy.sh); mail-worker needs no redeploy for logic but
rebuilds harmlessly; reload app tabs.
