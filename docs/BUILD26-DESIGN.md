# Build 26 — design contract (2026-08-05)

User ask: "the ability to delete notes on tickets that are not on
immutable/locked time approvals. This will delete the note, the associated
time entry, it will prompt for confirmation when deleted, and when the note is
deleted it will audit the user who deleted, what was on the note, and when this
happened. I want this audit log to be part of both the ticket and global audit
log." Mid-flight addition: "This should also apply to 'public reply' notes and
this should be differentiated on the audit."

## Why "delete" is a SOFT delete + a VOID (forced by the architecture)

The suite is append-only by construction; a hard delete is impossible and was
never intended:

- `ledger.guard_entry_immutability` (0001:616) RAISEs *"time entries are never
  deleted — void them"* on any `DELETE`. Time is removed by VOID only — exactly
  what `patch_time`'s "×" already does.
- `ledger.time_entries.article_id` is a plain (RESTRICT) FK to
  `desk.articles(id)` — an article with any linked entry can't be row-deleted.
- `DELETE is granted NOWHERE` (0001:776). "Voids and archives only."

So a note/reply is **tombstoned** (soft delete) and its linked time is
**voided**. The user-visible result is a delete; the record survives for the
audit, which is exactly what lets us report "what was on the note."

## Migration 0036 — `desk.articles.deleted_at / deleted_by`

Two nullable columns, no backfill, **no new grant, no guard change**:

- `deleted_at timestamptz` (NULL = live), `deleted_by text` (actor label).
- No grant: desk_api already holds UPDATE on all of schema `desk` (0001:762).
- No guard change: `desk.guard_article_immutability` (0001:326) only RAISEs when
  a **non-note body changes**. A soft delete never touches `body`, so for a
  `reply` the body-change test is false, and a `note` is never guarded — the two
  columns can be set on either kind with the trigger untouched.

## Backend — `DELETE /api/tickets/{id}/articles/{article_id}` (write.py)

Guards, in order (server-authoritative — never merely UI-hidden):

1. 404 — article absent / not on this ticket.
2. 409 — `kind NOT IN ('note','reply')` (mail_in / sys undeletable), or `is_auto`.
3. Idempotent — already tombstoned → `{ok, already:true}`, no second void/audit
   (mirrors `remove_schedule`). Checked **before** the freeze read/void so a
   double-click can't re-void or double-audit.
4. 423 — approved-locked project (`refuse_if_locked_project`).
5. **423 — the freeze gate**: any linked non-void entry with `ts_approved_at`
   set OR `ledger.period_locked(period_id)` true. This is the user's
   "not on immutable/locked time approvals" clause, reusing the 0034 SECURITY
   DEFINER period read so no `billing_periods` grant is needed. Identical clause
   to the note-edit endpoint.

Then: void every linked non-void entry (`status='void'`, `voided_at`,
`void_reason='note deleted'/'reply deleted'`) — `WHERE ts_approved_at IS NULL`
with a `try/except RaiseException → 409` belt-and-suspenders for a race; tombstone
the article (`deleted_at/deleted_by`); write the **dual audit** (build 22
pattern) — one ticket `sys` article (`_sys`) + one `audit.events` row
(`auth.audit`), the action named **"Internal note deleted"** vs **"Public reply
deleted"** so the two logs differentiate kind, with the capped original content
and voided hours in the detail; `_touch` the ticket (updated_at + version) and
return the fresh version/updatedAt so the client can't 409 its next edit.

**Permission (user's explicit choice): anyone who can access the ticket.** Any
authenticated session (PATs pass as service credentials); NO `auth.need()` gate.
The hard invariants still hold for everyone: approved/locked time (423), locked
project (423), mail_in/sys/auto (409). **Billing note:** because there is no
per-tech gate, deleting a note/reply voids its linked time regardless of whose
time it is — but only ever *unapproved, unlocked* time (the freeze gate blocks
anything already billed/approved), which is still fully editable/voidable today.

## Bootstrap (bootstrap.py)

Per-article `deletedAt/deletedBy` ride like `editedAt/editedBy`. A deleted
article ships with its **body/body_html stripped** (`CASE WHEN deleted_at IS
NULL THEN body ELSE '' END`) — the content is NOT sent to the thread; it lives
only in the audit sys article + audit.events. Attachments of a deleted article
are skipped (`AND ar.deleted_at IS NULL` on the atts join).

`fr_met` (SLA first-reply) is deliberately left counting a deleted reply: the
customer *did* receive that email; deleting it removes it from the thread
record, not the fact it was sent — so it must not retroactively un-meet the SLA.

## Frontend (api.js, tickets.js, desk.css)

- `mapIn` defaults `deletedAt/deletedBy` to null (pre-0036 safety).
- `renderArt` early-returns a muted **tombstone** for `a.deletedAt` — no body,
  no time chip, no actions — `🗑 Internal note / Public reply deleted by <who> ·
  <when>`. The tombstone stays in the thread (it's still `kind` note/reply, so
  `conv` includes it).
- A **Delete** button (`.rowbtn.danger`) on any live note/reply that isn't auto,
  isn't on a locked project, and isn't on approved/locked time — no permission
  gate (matches the product choice). `deleteArticle()` re-asserts every clause,
  **confirms** (naming the voided hours), then optimistically tombstones + voids
  + pushes the sys article + `log()`s the global row, and mirrors via `DELETE`,
  reconciling version/updatedAt. `srvId` guard skips the server call for a
  never-mirrored local note.
- CSS: `.art.deleted` (void-tinted, italic sys-style row) + `.rowbtn.danger`
  (matches `.btn.danger`'s void palette).

## Deploy

`git pull && ./deploy.sh` on the VM (0036 before the desk-api rebuild;
mail-worker untouched). Reload app tabs. Frontend-visible: the Delete control +
tombstone; the linked-time void mirrors to Ledger as a voided row.
