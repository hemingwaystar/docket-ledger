"""Ticket writes: create, the optimistic-locked property patch (with the
0025 parent/child bookkeeping), client moves, and tags. Locked projects
refuse everything (423)."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from .. import auth, db, helpers
from .common import emit_event, live_parent_of, sys_note

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
                sets.append("title = %s"); args.append(body.title); notes.append("title")
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
                        "WHERE id = %s AND version = %s RETURNING version", args)
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
        auth.audit(conn, "desk", "Ticket updated", f"ticket:{ticket_id}",
                   f"#{ticket_id} · " + " · ".join(notes))
        return {"ok": True, "changed": notes, "version": updated[0]}


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
        if body.add or body.remove:
            auth.audit(conn, "desk", "Tags updated", f"ticket:{ticket_id}",
                       f"#{ticket_id} +[{', '.join(body.add)}] -[{', '.join(body.remove)}]")
        return {"ok": True}
