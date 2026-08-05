"""Ticket writes: create, the optimistic-locked property patch (with the
0025 parent/child bookkeeping), client moves, tags, the assignee-set
full-replace (0032 membership join — additional techs beyond the single
owner), the per-tech schedule add/remove (0033 — each write keeps
desk.tickets.pending_until in sync as the MIN future scheduled start, which
is what drives the existing worker/UI auto-resume), and the note edit (0034 —
correct a sent internal note's body + add attachments, guarded and audited;
it touches desk.articles ONLY, never desk.tickets, so it neither reads nor
bumps ticket.version and cannot 409). Locked projects refuse everything (423)."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from .. import auth, db, helpers
from .common import _sane_span, emit_event, live_parent_of, sys_note

router = APIRouter(prefix="/api")


class NewTicket(BaseModel):
    title: str
    client: str
    group: str
    contact_email: str | None = None
    priority: str = "Normal"


@router.post("/tickets", status_code=201)
def create_ticket(body: NewTicket, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'create')
        with conn.cursor() as cur:
            client_id = helpers.client_id(cur, body.client)
            group_id = helpers.group_id(cur, body.group)
            priority = helpers.priority_id(cur, body.priority)
            contact_id = None
            if body.contact_email:
                cur.execute("SELECT id FROM shared.contacts WHERE lower(email) = lower(%s)",
                            (body.contact_email,))
                row = cur.fetchone()
                contact_id = row[0] if row else None
            cur.execute(
                """INSERT INTO desk.tickets
                     (title, client_id, contact_id, group_id, state_id, priority_id)
                   VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
                (body.title, client_id, contact_id, group_id,
                 helpers.state_id(cur, "New"), priority))
            (ticket_id,) = cur.fetchone()
            emit_event(cur, "create", ticket_id)
        auth.audit(conn, "desk", "Ticket created", f"ticket:{ticket_id}",
                   f"#{ticket_id} {body.title} — via API ({who['label']})")
        return {"id": ticket_id}


class PatchTicket(BaseModel):
    version: int                       # optimistic lock — from your last read
    title: str | None = None
    state: str | None = None
    contact: str | None = None         # contact uuid or email; "" clears
    priority: str | None = None
    owner_email: str | None = None     # "" clears the owner
    group: str | None = None
    pending_until: str | None = None   # ISO; "" clears


@router.patch("/tickets/{ticket_id}")
def patch_ticket(ticket_id: int, body: PatchTicket, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'edit_props', 'assign', 'close')
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            sets, args, notes = [], [], []
            old_kind = new_kind = None
            if body.title is not None:
                sets.append("title = %s"); args.append(body.title); notes.append(f"title → {body.title}")
            if body.state is not None:
                cur.execute("""SELECT id, kind, is_system FROM desk.ticket_states
                                WHERE lower(label) = lower(%s) AND active""", (body.state,))
                strow = cur.fetchone()
                if strow is None:
                    raise HTTPException(404, "Unknown state")
                if strow[2]:
                    raise HTTPException(422, f"\u201c{body.state}\u201d is a system state — "
                                        "the parent-close cascade sets it; it can't be picked by hand")
                cur.execute("""SELECT s.kind FROM desk.tickets t
                                 JOIN desk.ticket_states s ON s.id = t.state_id
                                WHERE t.id = %s""", (ticket_id,))
                (old_kind,) = cur.fetchone()
                new_kind = strow[1]
                sets.append("state_id = %s"); args.append(strow[0])
                notes.append(f"state → {body.state}")
            if body.priority is not None:
                sets.append("priority_id = %s"); args.append(helpers.priority_id(cur, body.priority))
                notes.append(f"priority → {body.priority}")
            if body.contact is not None:
                if body.contact == "":
                    sets.append("contact_id = NULL"); notes.append("contact cleared")
                else:
                    pid, pname = helpers.contact(cur, body.contact)
                    sets.append("contact_id = %s"); args.append(pid)
                    notes.append(f"contact → {pname}")
            if body.owner_email is not None:
                if body.owner_email == "":
                    sets.append("owner_id = NULL"); notes.append("owner cleared")
                else:
                    aid, name = helpers.agent(cur, body.owner_email)
                    sets.append("owner_id = %s"); args.append(aid)
                    notes.append(f"owner → {name}")
            if body.group is not None:
                sets.append("group_id = %s"); args.append(helpers.group_id(cur, body.group))
                notes.append(f"group → {body.group}")
            if body.pending_until is not None:
                if body.pending_until == "":
                    sets.append("pending_until = NULL"); notes.append("pending cleared")
                else:
                    sets.append("pending_until = %s"); args.append(body.pending_until)
                    notes.append(f"pending until {body.pending_until}")
            if not sets:
                return {"ok": True, "changed": []}
            args += [ticket_id, body.version]
            cur.execute(f"UPDATE desk.tickets SET {', '.join(sets)} "
                        "WHERE id = %s AND version = %s RETURNING version, updated_at", args)
            updated = cur.fetchone()
            if updated is None:
                raise HTTPException(409, "Version conflict — re-read the ticket and retry")
            if body.state is not None:
                emit_event(cur, "state", ticket_id)
                # parent/child bookkeeping (0025): the parent hears about the
                # edges that matter, as sys notes — never state changes
                parent = live_parent_of(cur, ticket_id)
                if parent is not None:
                    if new_kind == 'done' and old_kind != 'done':
                        cur.execute("""SELECT count(*) FROM desk.ticket_links l
                                         JOIN desk.tickets c ON c.id = l.dst_id
                                         JOIN desk.ticket_states s ON s.id = c.state_id
                                        WHERE l.kind = 'child' AND l.voided_at IS NULL
                                          AND l.src_id = %s AND s.kind <> 'done'""",
                                    (parent,))
                        (still_open,) = cur.fetchone()
                        if still_open == 0:
                            sys_note(cur, parent, f"All child tickets are resolved — "
                                     f"#{ticket_id} was the last. Ready to close?")
                            cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s",
                                        (parent,))
                    elif new_kind != 'done' and old_kind == 'done':
                        cur.execute("""SELECT s.kind FROM desk.tickets t
                                         JOIN desk.ticket_states s ON s.id = t.state_id
                                        WHERE t.id = %s""", (parent,))
                        (pkind,) = cur.fetchone()
                        if pkind == 'done':
                            sys_note(cur, parent,
                                     f"Child #{ticket_id} reopened after this parent was closed.")
                            cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s",
                                        (parent,))
            if body.priority is not None:
                emit_event(cur, "priority", ticket_id)
            if body.owner_email:                     # "" clears — no owner event
                emit_event(cur, "owner", ticket_id)
            # ticket-audit sibling (build 22): the same change auth.audit records
            # to the system Audit Log now also lands on the ticket's Audit block,
            # so a property change is visible in BOTH places (previously only the
            # system log got it — the sys article was frontend-optimistic only and
            # vanished on the next hydrate).
            _sys(cur, ticket_id, who, "Ticket updated — " + " · ".join(notes))
        auth.audit(conn, "desk", "Ticket updated", f"ticket:{ticket_id}",
                   f"#{ticket_id} · " + " · ".join(notes))
        return {"ok": True, "changed": notes, "version": updated[0],
                "updatedAt": _ms(updated[1])}


class Reclient(BaseModel):
    client: str            # target client name or uuid
    version: int


@router.post("/tickets/{ticket_id}/client")
def reclient_ticket(ticket_id: int, body: Reclient, request: Request):
    """Move a ticket to another client. If it arrived unrouted, the sender's
    auto-created contact is claimed into the new client; still-open Ledger
    entries follow (approved/locked billing never moves — 0009 fn filters,
    and the immutability guard would refuse regardless)."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'edit_props')
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            new_id = helpers.client_id(cur, body.client)
            cur.execute("SELECT name, is_sentinel FROM shared.clients WHERE id = %s",
                        (new_id,))
            new_name, new_sentinel = cur.fetchone()
            if new_sentinel:
                raise HTTPException(422, "Tickets leave Unassigned intake — they don't move into it")
            old_id = row[1]
            if new_id == old_id:
                return {"ok": True, "changed": [], "version": row[3]}
            cur.execute("""SELECT c.name, c.is_sentinel, t.contact_id
                             FROM desk.tickets t JOIN shared.clients c ON c.id = t.client_id
                            WHERE t.id = %s""", (ticket_id,))
            old_name, old_sentinel, contact_id = cur.fetchone()
            cur.execute("""UPDATE desk.tickets SET client_id = %s
                            WHERE id = %s AND version = %s RETURNING version""",
                        (new_id, ticket_id, body.version))
            updated = cur.fetchone()
            if updated is None:
                raise HTTPException(409, "Version conflict — re-read the ticket and retry")
            claimed = None
            if contact_id and old_sentinel:   # claim the sender out of the intake pool
                cur.execute("""UPDATE shared.contacts SET client_id = %s
                                WHERE id = %s AND client_id = %s RETURNING name""",
                            (new_id, contact_id, old_id))
                r = cur.fetchone()
                claimed = r[0] if r else None
            cur.execute("DELETE FROM desk.ticket_tags WHERE ticket_id = %s AND tag = 'unrouted'",
                        (ticket_id,))
            cur.execute("SELECT moved, kept FROM ledger.reclient_ticket_entries(%s, %s)",
                        (ticket_id, new_id))
            moved, kept = cur.fetchone()
            bits = [f"Moved to {new_name}"]
            if claimed:
                bits.append(f"{claimed} added to their contacts")
            if moved:
                bits.append(f"{moved} open time entr{'y follows' if moved == 1 else 'ies follow'}")
            if kept:
                bits.append(f"{kept} stay with {old_name} (approved/locked billing)")
            cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, author_id, body)
                           VALUES (%s, 'sys', %s, %s, %s)""",
                        (ticket_id, who.get("name") or who.get("label") or "API",
                         who.get("agent_id"), " · ".join(bits)))
        auth.audit(conn, "desk", "Ticket moved to client", f"ticket:{ticket_id}",
                   f"#{ticket_id} · {old_name} → {new_name}"
                   + (" · sender claimed as contact" if claimed else "")
                   + (f" · {moved} entries moved, {kept} kept" if (moved or kept) else ""))
        return {"ok": True, "changed": [f"client → {new_name}"], "version": updated[0]}


class Tags(BaseModel):
    add: list[str] = []
    remove: list[str] = []


@router.post("/tickets/{ticket_id}/tags")
def tags(ticket_id: int, body: Tags, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'edit_props')
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            for t in body.add:
                cur.execute("""INSERT INTO desk.ticket_tags (ticket_id, tag)
                               VALUES (%s, %s) ON CONFLICT DO NOTHING""",
                            (ticket_id, t.lower().strip().replace(" ", "-")))
            for t in body.remove:
                cur.execute("DELETE FROM desk.ticket_tags WHERE ticket_id = %s AND tag = %s",
                            (ticket_id, t))
            version = updated_ms = None
            if body.add or body.remove:
                # ticket-audit sibling + 'updated' bump (build 22): a tag change
                # now shows on the ticket's Audit block and re-sorts the board,
                # not just the system Audit Log. Version returned so the client
                # refreshes its lock token.
                norm = lambda xs: [x.lower().strip().replace(" ", "-") for x in xs]
                parts = []
                if body.add:    parts.append("added " + ", ".join(norm(body.add)))
                if body.remove: parts.append("removed " + ", ".join(norm(body.remove)))
                _sys(cur, ticket_id, who, "Tags " + " · ".join(parts))
                version, updated_ms = _touch(cur, ticket_id)
        if body.add or body.remove:
            auth.audit(conn, "desk", "Tags updated", f"ticket:{ticket_id}",
                       f"#{ticket_id} +[{', '.join(body.add)}] -[{', '.join(body.remove)}]")
        return {"ok": True, "version": version, "updatedAt": updated_ms}


class Assignees(BaseModel):
    assignees: list[str] = []          # agent uuids — the FULL desired set (replace)


@router.put("/tickets/{ticket_id}/assignees")
def set_assignees(ticket_id: int, body: Assignees, request: Request):
    """Full-replace the additional-tech set on a ticket (0032). Assignees live
    in desk.ticket_assignees, a membership join separate from the single
    owner_id: an assignee gains visibility and the ticket counts in their
    "Mine". Modeled on directory.patch_agent's {groups} replace — delete the
    rows that fell out of the new set, INSERT ... ON CONFLICT DO NOTHING the
    survivors, one transaction.

    The membership write carries NO version predicate, so it never raises the
    optimistic-lock 409 that patch_ticket/reclient can. It DOES (build 22) then
    _touch the tickets row so the change marks the ticket 'updated' — that bump
    is unconditional (no predicate) and its new version is returned so the client
    refreshes its lock token (build 14b/16 F1)."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'assign')
        with conn.cursor() as cur:
            helpers.refuse_if_locked_project(helpers.ticket_or_404(cur, ticket_id))
            # Resolve + validate the requested set. Only ACTIVE agents may be
            # assigned; unknown/inactive ids are SKIPPED (documented) rather
            # than 422 — a stale UI selection must not fail the whole save, and
            # the frontend rehydrates from the returned authoritative set. Dedup
            # here so the sys-article label doesn't repeat a name.
            wanted, names, seen = [], [], set()
            for aid in body.assignees:
                if aid in seen:
                    continue
                seen.add(aid)
                cur.execute("SELECT id, name FROM shared.agents WHERE id::text = %s AND active",
                            (aid,))
                r = cur.fetchone()
                if r is None:
                    continue                       # skip unknown/inactive — documented
                wanted.append(str(r[0])); names.append(r[1])
            # Full-list replace. This DELETE is in-doctrine: ticket_assignees is
            # a membership join (like shared.agent_groups, 0011), not a business
            # record — the audit line + sys article below are the history. Diff
            # style (delete only what fell out) preserves added_at/added_by for
            # techs who stay; the empty set (clear all) is its own branch so we
            # never lean on empty-array param adaptation.
            if wanted:
                cur.execute("""DELETE FROM desk.ticket_assignees
                                WHERE ticket_id = %s AND NOT (agent_id = ANY(%s::uuid[]))""",
                            (ticket_id, wanted))
            else:
                cur.execute("DELETE FROM desk.ticket_assignees WHERE ticket_id = %s",
                            (ticket_id,))
            for aid in wanted:
                cur.execute("""INSERT INTO desk.ticket_assignees (ticket_id, agent_id, added_by)
                               VALUES (%s, %s, %s) ON CONFLICT DO NOTHING""",
                            (ticket_id, aid, who.get("name") or who.get("label") or "API"))
            # One sys article on the ticket narrating the resulting set — the
            # same way an owner change is narrated on the ticket. Independent of
            # any version lock; author_id NULL for PAT callers (mirrors reclient).
            label = ("Assignees: " + ", ".join(names)) if names else "Assignees cleared"
            _sys(cur, ticket_id, who, label)
            # mark the ticket 'updated' (build 22): an assignee change now bumps
            # updated_at/version like any other change. The bump is returned so
            # the client refreshes its optimistic-lock token (the side-table write
            # itself still carries no version predicate — no 409 here).
            version, updated_ms = _touch(cur, ticket_id)
        auth.audit(conn, "desk", "Assignees updated", f"ticket:{ticket_id}",
                   f"#{ticket_id} · " + label)
        return {"ok": True, "assignees": wanted, "version": version, "updatedAt": updated_ms}


# --- Schedules (0033) -------------------------------------------------------
# Per-tech time blocks on on-hold tickets (the "Schedules" bar). Adding or
# removing a block RECOMPUTES desk.tickets.pending_until = MIN(starts_at) among
# the ticket's FUTURE schedule rows (NULL if none) and writes it directly as a
# derived value. That derived pending_until is the ONLY coupling to resume: the
# mail-worker's wake_pending() and the frontend's checkPendingWakes() both act
# on it unchanged (the worker service is not touched by this build). Schedules
# thus REPLACE the old hand-set "Wake up" field — pending_until is never edited
# by hand in the UI anymore, only derived here.

def _ms(dt):
    """epoch ms | None — the same unit every ticket timestamp uses in bootstrap,
    so the UI reuses fmtDT/dtLocalVal/checkPendingWakes without translation."""
    return int(dt.timestamp() * 1000) if dt else None


def _touch(cur, ticket_id: int):
    """Bump desk.tickets.updated_at (and, via the 0001 touch trigger, version) so
    ANY change marks the ticket 'updated' and re-sorts the board. Returns the new
    (version, updated_at ms) so a SIDE-table endpoint (assignees/tags/note-edit)
    can hand them back — a version bump the client never sees would 409 its next
    property edit (build 14b / build 16 F1). Endpoints that already UPDATE
    desk.tickets in the same txn (patch_ticket, reclient, schedules) inherit the
    same bump directly and don't need this."""
    cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s "
                "RETURNING version, updated_at", (ticket_id,))
    v, u = cur.fetchone()
    return v, _ms(u)


def _sys(cur, ticket_id: int, who: dict, body: str):
    """A ticket 'sys' article authored by the acting user (author_id NULL for
    PATs) — the ticket-audit-log sibling of auth.audit's audit.events line. Every
    mutating endpoint writes BOTH so the ticket's Audit block and the system
    Audit Log stay in lockstep (build 22)."""
    cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, author_id, body)
                   VALUES (%s, 'sys', %s, %s, %s)""",
                (ticket_id, who.get("name") or who.get("label") or "API",
                 who.get("agent_id"), body))


def _span_label(starts_at: str, ends_at: str | None) -> str:
    """Human 'start–end' (or 'from start') for the sys article. Inputs already
    passed _sane_span, so fromisoformat parses; fall back to the raw string."""
    from datetime import datetime
    def fmt(v):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M")
        except (ValueError, AttributeError):
            return v
    return f"{fmt(starts_at)}–{fmt(ends_at)}" if ends_at else f"from {fmt(starts_at)}"


def _span_label_dt(starts_at, ends_at) -> str:
    """_span_label's sibling for datetimes already read from the DB (the
    complete/reopen endpoint has the stored row, not the client's ISO strings).
    strftime works directly on the aware datetimes; None end drops to 'from'."""
    def fmt(v):
        return v.strftime("%Y-%m-%d %H:%M") if v else None
    return f"{fmt(starts_at)}–{fmt(ends_at)}" if ends_at else f"from {fmt(starts_at)}"


def _sync_pending(cur, ticket_id: int):
    """Recompute desk.tickets.pending_until as MIN future scheduled start (NULL
    if none) and persist it with a VERSION-FREE update (this is a derived value,
    not a user edit — so it never contends the optimistic lock and never raises
    the 409). Returns (schedules list [ms timestamps, sorted by start],
    pending_until [ms|None], version [int]) for the endpoint response so the UI
    reconciles all three from one payload. NOTE: this write is version-FREE (no
    predicate — it never contends the optimistic lock, so no 409), BUT the
    tickets `touch` trigger still bumps version on every UPDATE; we RETURN the
    new version so the UI can refresh its optimistic-lock token and a later
    property edit doesn't 409 on a stale version."""
    # A COMPLETED block (0035) no longer drives auto-resume — a done task should
    # not reopen the ticket at its start — so the MIN excludes completed rows.
    cur.execute("""SELECT min(starts_at) FROM desk.ticket_schedules
                    WHERE ticket_id = %s AND starts_at > now()
                      AND completed_at IS NULL""", (ticket_id,))
    (pending,) = cur.fetchone()
    cur.execute("UPDATE desk.tickets SET pending_until = %s WHERE id = %s "
                "RETURNING version", (pending, ticket_id))   # no version predicate — derived
    (version,) = cur.fetchone()
    cur.execute("""SELECT id, agent_id, starts_at, ends_at, note,
                          completed_at, completed_by
                     FROM desk.ticket_schedules
                    WHERE ticket_id = %s ORDER BY starts_at""", (ticket_id,))
    schedules = [{"id": str(r[0]), "agentId": str(r[1]),
                  "startsAt": _ms(r[2]), "endsAt": _ms(r[3]), "note": r[4],
                  "completedAt": _ms(r[5]), "completedBy": r[6]}
                 for r in cur.fetchall()]
    return schedules, _ms(pending), version


class NewSchedule(BaseModel):
    agent_id: str                      # the scheduled tech (agent uuid)
    starts_at: str                     # ISO8601 — block start; MIN future start drives resume
    ends_at: str | None = None         # ISO8601 | null — optional block end
    note: str | None = None            # optional free-text note


@router.post("/tickets/{ticket_id}/schedules")
def add_schedule(ticket_id: int, body: NewSchedule, request: Request):
    """Add one per-tech schedule block, then re-derive pending_until. Like
    set_assignees this deliberately does NOT read or bump desk.tickets.version
    (pending_until is written as a derived value on the tickets row, no version
    predicate), so it cannot raise the optimistic-lock 409. The span-sanity
    guard (bug #27) rejects a mistyped year before anything is written."""
    _sane_span(body.starts_at, body.ends_at)
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'assign')
        with conn.cursor() as cur:
            helpers.refuse_if_locked_project(helpers.ticket_or_404(cur, ticket_id))
            # Only ACTIVE agents may be scheduled — a hard 422 (a single-tech
            # add, unlike the assignee full-replace, has no other row to keep).
            cur.execute("SELECT id, name FROM shared.agents WHERE id::text = %s AND active",
                        (body.agent_id,))
            r = cur.fetchone()
            if r is None:
                raise HTTPException(422, "Schedule tech must be an active agent")
            agent_id, agent_name = str(r[0]), r[1]
            cur.execute("""INSERT INTO desk.ticket_schedules
                             (ticket_id, agent_id, starts_at, ends_at, note, created_by)
                           VALUES (%s, %s, %s, %s, %s, %s)""",
                        (ticket_id, agent_id, body.starts_at, body.ends_at,
                         (body.note or None), who.get("name") or who.get("label") or "API"))
            schedules, pending, version = _sync_pending(cur, ticket_id)
            # One sys article narrating the block (author_id NULL for PATs —
            # mirrors reclient/set_assignees); version-independent.
            label = f"Scheduled {agent_name} {_span_label(body.starts_at, body.ends_at)}"
            cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, author_id, body)
                           VALUES (%s, 'sys', %s, %s, %s)""",
                        (ticket_id, who.get("name") or who.get("label") or "API",
                         who.get("agent_id"), label))
        auth.audit(conn, "desk", "Schedule added", f"ticket:{ticket_id}",
                   f"#{ticket_id} · " + label)
        return {"ok": True, "schedules": schedules, "pending_until": pending, "version": version}


@router.delete("/tickets/{ticket_id}/schedules/{schedule_id}")
def remove_schedule(ticket_id: int, schedule_id: int, request: Request):
    """Remove one schedule block (scoped to the ticket), then re-derive
    pending_until the same version-free way. Idempotent: a block already gone
    (double-click, stale UI) returns ok with the current list rather than 404,
    so the optimistic UI reconciles instead of oops()-ing; the audit line is
    written only when a row actually left."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'assign')
        with conn.cursor() as cur:
            helpers.refuse_if_locked_project(helpers.ticket_or_404(cur, ticket_id))
            cur.execute("""DELETE FROM desk.ticket_schedules
                            WHERE id = %s AND ticket_id = %s RETURNING agent_id""",
                        (schedule_id, ticket_id))
            gone = cur.fetchone()
            schedules, pending, version = _sync_pending(cur, ticket_id)
        if gone is not None:
            auth.audit(conn, "desk", "Schedule removed", f"ticket:{ticket_id}",
                       f"#{ticket_id} · schedule {schedule_id} removed")
        return {"ok": True, "schedules": schedules, "pending_until": pending, "version": version}


class ScheduleDone(BaseModel):
    done: bool = True                  # true = mark complete, false = reopen


@router.post("/tickets/{ticket_id}/schedules/{schedule_id}/complete")
def complete_schedule(ticket_id: int, schedule_id: int, body: ScheduleDone, request: Request):
    """Mark one schedule block complete (or reopen it), then re-derive
    pending_until (a completed block no longer drives auto-resume — see
    _sync_pending / 0035). WHO + WHEN are recorded three ways: the row stamps
    completed_by/completed_at, a sys article narrates it on the ticket thread,
    and auth.audit writes an audit.events row (actor + timestamp captured via
    app.actor). PERMISSION: the block's OWN tech may check their task off;
    anyone else needs 'assign' (the same gate add/remove use). Idempotent — a
    no-op toggle (already in the requested state) returns ok with the current
    list and writes no audit/article, so the optimistic UI reconciles cleanly."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        with conn.cursor() as cur:
            helpers.refuse_if_locked_project(helpers.ticket_or_404(cur, ticket_id))
            cur.execute("""SELECT s.agent_id, a.name, s.starts_at, s.ends_at
                             FROM desk.ticket_schedules s
                             JOIN shared.agents a ON a.id = s.agent_id
                            WHERE s.id = %s AND s.ticket_id = %s""",
                        (schedule_id, ticket_id))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "Schedule block not found")
            sched_agent, agent_name, starts_at, ends_at = str(row[0]), row[1], row[2], row[3]
            # a block's own tech can check it off; otherwise it takes 'assign'
            if not (who["kind"] == "pat"
                    or ("assign" in who.get("perms", set()))
                    or str(who.get("agent_id")) == sched_agent):
                raise HTTPException(403, "Marking another tech's schedule needs the assign permission")
            actor = who.get("name") or who.get("label") or "API"
            if body.done:
                cur.execute("""UPDATE desk.ticket_schedules SET completed_at = now(), completed_by = %s
                                WHERE id = %s AND ticket_id = %s AND completed_at IS NULL""",
                            (actor, schedule_id, ticket_id))
            else:
                cur.execute("""UPDATE desk.ticket_schedules SET completed_at = NULL, completed_by = NULL
                                WHERE id = %s AND ticket_id = %s AND completed_at IS NOT NULL""",
                            (schedule_id, ticket_id))
            changed = cur.rowcount > 0
            schedules, pending, version = _sync_pending(cur, ticket_id)
            label = ""
            if changed:
                verb = "completed" if body.done else "reopened"
                label = f"Schedule for {agent_name} {_span_label_dt(starts_at, ends_at)} {verb}"
                cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, author_id, body)
                               VALUES (%s, 'sys', %s, %s, %s)""",
                            (ticket_id, actor, who.get("agent_id"), label))
        if changed:
            auth.audit(conn, "desk", "Schedule " + ("completed" if body.done else "reopened"),
                       f"ticket:{ticket_id}", f"#{ticket_id} · " + label)
        return {"ok": True, "schedules": schedules, "pending_until": pending, "version": version}


# --- Note editing (0034) ----------------------------------------------------
# Edit a SENT internal note in place: correct its body and/or add attachments,
# with hard server-authoritative guards and a full before→after audit line.
# Notes are the ONLY editable article kind — 0001's guard_article_immutability
# freezes reply/mail_in/sys bodies at the DB; this endpoint layers the business
# rules on top. The body/attachment write carries NO version predicate, so the
# edit itself never 409s. Build 22 then writes a ticket sys article and _touches
# the tickets row (updated_at + version) so the edit shows in the ticket's Audit
# block and marks the ticket 'updated' — the version bump is RETURNED so the
# client refreshes its lock token and the build-14b staleness bug is avoided.

def _cap_body(s: str, cap: int = 4000) -> str:
    """Bound a note body for the audit detail so a pathological paste can't mint
    a monster audit row; note the truncation when it bites."""
    s = s or ""
    return s if len(s) <= cap else s[:cap] + f"… [+{len(s) - cap} more chars]"


class EditNote(BaseModel):
    body: str
    attachment_ids: list[str] = []     # newly-staged uploads to link (optional)


@router.patch("/tickets/{ticket_id}/articles/{article_id}")
def edit_note(ticket_id: int, article_id: str, body: EditNote, request: Request):
    """Edit an internal note (kind='note') — body + added attachments — with
    server-authoritative guards and one full before→after audit line.

    Refuses (never merely UI-hidden) when the note can't be edited by ANYONE:
      * it isn't a note, or it's auto-generated                → 409
      * the ticket is an approved-locked project (projLocked)  → 423
      * its linked timesheet is frozen — the ledger entry is manager-approved
        (ts_approved_at) OR in a locked/exported billing period → 423
    The linked-timesheet check is the crux: this UPDATEs desk.articles, NOT
    ledger.time_entries, so the ledger's own SECURITY DEFINER immutability guard
    never fires — this endpoint IS the enforcer. It reads the period lock via
    ledger.period_locked() (0034) so no billing_periods grant is needed.

    Then refuses when THIS caller may not edit it (403): allowed only for the
    note's own author or a see_billing supervisor (mirrors patch_time's
    own-vs-see_billing split and the renderArt isMineOrSup gate); PATs pass as
    all-scope service credentials.

    Returns the reconciled article {id, body, editedAt (ms), editedBy,
    attachments:[{id,filename,byteSize,mimeType}]} so the UI updates the one
    article without a full rehydrate."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        with conn.cursor() as cur:
            # 1) ticket + article — both 404 if absent / not on this ticket.
            trow = helpers.ticket_or_404(cur, ticket_id)
            cur.execute("""SELECT kind, is_auto, author_id, body
                             FROM desk.articles
                            WHERE id = %s AND ticket_id = %s""",
                        (article_id, ticket_id))
            art = cur.fetchone()
            if art is None:
                raise HTTPException(404, "No such article on this ticket")
            kind, is_auto, author_id, old_body = art
            # 2) not-editable-by-ANYONE refusals.
            if kind != "note":
                raise HTTPException(409, "Only internal notes can be edited — "
                                    "replies and system entries are immutable")
            if is_auto:
                raise HTTPException(409, "Auto-generated notes can't be edited")
            helpers.refuse_if_locked_project(trow)     # 423 on an approved-locked project
            # 3) the linked-timesheet freeze: ts-approved OR period-locked. One
            #    read over ledger.time_entries (desk_api SELECTs it directly);
            #    the period lock arrives through the definer function so desk_api
            #    needs no billing_periods grant. A note can carry more than one
            #    linked entry over its life — any frozen one freezes the note.
            cur.execute("""SELECT e.ts_approved_at IS NOT NULL,
                                  ledger.period_locked(e.period_id)
                             FROM ledger.time_entries e
                            WHERE e.article_id = %s AND e.status <> 'void'""",
                        (article_id,))
            for ts_approved, period_locked in cur.fetchall():
                if ts_approved or period_locked:
                    raise HTTPException(423, "The linked timesheet is approved — "
                                        "the note is frozen with it")
            # 4) permission: the author, or a see_billing supervisor; PATs pass.
            if who["kind"] == "session" and author_id != who["agent_id"]:
                auth.need(who, "see_billing")
            actor = who.get("name") or who.get("label") or "API"
            # 5) apply. The guard permits note-body edits + the 0034 columns
            #    (it only blocks body changes on NON-note kinds).
            cur.execute("""UPDATE desk.articles
                              SET body = %s, edited_at = now(), edited_by = %s
                            WHERE id = %s RETURNING edited_at""",
                        (body.body, actor, article_id))
            (edited_at,) = cur.fetchone()
            # link newly-staged uploads — the SAME mechanism add_article uses:
            # only rows still unlinked (article_id IS NULL) are claimed, so a
            # stale/foreign id is silently skipped rather than stealing another
            # article's attachment. RETURNING names the files actually linked.
            added = []
            if body.attachment_ids:
                cur.execute("""UPDATE desk.attachments
                                  SET article_id = %s, staged_by = NULL
                                WHERE id = ANY(%s::uuid[]) AND article_id IS NULL
                            RETURNING filename""",
                            (article_id, body.attachment_ids))
                added = [r[0] for r in cur.fetchall()]
            # the article's full non-inline attachment set (same shape+filter as
            # the bootstrap atts join) so the UI reconciles one article cleanly.
            cur.execute("""SELECT id, filename, byte_size, mime_type
                             FROM desk.attachments
                            WHERE article_id = %s AND NOT is_inline
                            ORDER BY created_at""", (article_id,))
            atts = [{"id": str(r[0]), "filename": r[1], "byteSize": r[2],
                     "mimeType": r[3]} for r in cur.fetchall()]
            # 6a) ticket-audit sibling + 'updated' bump (build 22). Previously a
            #     note edit hit ONLY the system Audit Log and deliberately left the
            #     ticket untouched; now it also writes a sys article (before→after,
            #     capped for the block) and _touches the ticket so it shows in the
            #     ticket's Audit block AND re-sorts the board as 'updated'. The
            #     version bump is returned so the client refreshes its lock token.
            note_lbl = (f"Internal note edited — before “{_cap_body(old_body, 300)}” "
                        f"→ after “{_cap_body(body.body, 300)}”")
            if added:
                note_lbl += " · +attachments: " + ", ".join(added)
            _sys(cur, ticket_id, who, note_lbl)
            version, updated_ms = _touch(cur, ticket_id)
        # 6b) ONE system-log line: before → after (each capped) + added files + actor.
        detail = (f"#{ticket_id} · note {article_id} edited by {actor} · "
                  f"before “{_cap_body(old_body)}” "
                  f"→ after “{_cap_body(body.body)}”")
        if added:
            detail += " · +attachments: " + ", ".join(added)
        auth.audit(conn, "desk", "Note edited", f"ticket:{ticket_id}", detail)
        # 7) reconciled article + the ticket's bumped version/updated_at so the
        #    client syncs its lock token and the "Updated" column without a full
        #    rehydrate.
        return {"ok": True, "version": version, "updatedAt": updated_ms, "article": {
            "id": str(article_id), "body": body.body,
            "editedAt": _ms(edited_at), "editedBy": actor, "attachments": atts}}
