# Build 17 — design contract (2026-08-02)

User ask: "the ability to edit all notes after they have been sent" —
including adding attachments; EXPLICITLY not when the linked timesheet is
approved/immutable; and every change must hit the audit log with the note
content before/after, who, and when.

## What the DB already gave us

`desk.guard_article_immutability` (0001:326) already permits UPDATE of a
`kind='note'` body and RAISEs on any other kind — so replies/mail_in/sys
are immutable by construction, and note editing needs NO change to that
guard. desk_api already holds UPDATE on desk tables. So the schema work is
only the transparency column.

## Migration 0034

- `desk.articles.edited_at timestamptz`, `edited_by text` (nullable, no
  backfill) — for the "(edited)" marker.
- `ledger.period_locked(uuid) → bool` SECURITY DEFINER (status IN
  ('approved','exported')), EXECUTE granted to desk_api. This lets the
  desk note-edit endpoint learn a linked entry's period-lock WITHOUT a
  billing_periods read grant — preserving the documented "desk_api cannot
  read periods" segmentation, mirroring the 0003/0006/0012 definer
  precedent. (The ledger's own guard_entry_immutability can't protect a
  desk.articles UPDATE, so the desk side must check explicitly.)

## Backend — PATCH /api/tickets/{id}/articles/{article_id}

Body {body, attachment_ids?}. Guards in order: 404 ticket+article; 409 if
kind!='note' or auto; 423 if projLocked; **423 if the linked
ledger.time_entries row is ts_approved OR ledger.period_locked** (the
approved/locked-timesheet block — both conditions, since a period can be
approved without per-entry ts_approval); 403 unless the caller is the
note's author OR holds see_billing. Then: capture OLD body, UPDATE
body+edited_at+edited_by, link staged attachments via add_article's exact
predicate (article_id IS NULL), write ONE capped before→after audit line
(+ added filenames; who via actor, when via created_at), return the
reconciled article. Touches desk.articles/attachments ONLY — never
desk.tickets — so no version bump and no 409.

## Frontend

- renderArt gains an Edit affordance shown ONLY when: kind='note' &&
  !auto && (author || see_billing) && !projLocked && !(time.approved ||
  time.locked). Inline editor (textarea + attachment add via the
  composer's stageUploads) → editNote() PATCHes, optimistic + reconcile +
  oops. A muted "(edited <when>)" marker on any edited article. editNote
  does NOT fabricate t.updatedAt (the edit doesn't move the ticket's
  Updated time / board sort — verifier F1).
- bootstrap emits per-article author.id/editedAt/editedBy and per-time
  `locked`; mapIn defaults editedAt/editedBy.

## Verification

2 implementers (disjoint files) → 2 adversarial verifiers + a Python/SQL
auditor. The break-it pass confirmed the gates are server-authoritative:
approved-entry AND locked-period both refuse (423), replies/sys/auto
refuse (409) with the DB trigger as backstop, non-author-without-
see_billing refuses (403), exactly one complete audit row per edit with
no partial write on refusal, attachment-hijack prevented (article_id IS
NULL predicate), injection-safe (esc/jsq). One minor finding (optimistic
updatedAt bump) fixed. Behavioral checks in headless Edge: all 10 edit-
affordance gates + the "(edited)" marker pass. Deploy: 0034 before
desk-api rebuilds; mail-worker untouched; reload app tabs.
