"""Ticket links (0025): related (symmetric) + child (directed, one level),
void-only unlink, and the parent close cascade."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Literal
from .. import auth, db, helpers
from .common import emit_event, live_parent_of, sys_note

router = APIRouter(prefix="/api")


class LinkSpec(BaseModel):
    kind: Literal["related", "child"]
    other: int          # kind='child': OTHER becomes the child of {ticket_id}


@router.post("/tickets/{ticket_id}/links", status_code=201)
def link_tickets(ticket_id: int, body: LinkSpec, request: Request):
    """Create a link. Hierarchy is strictly one level: a parent may have any
    number of children, but a child can NEVER itself be a parent — refused
    with an explicit 409, same sentence the UI shows."""
    if body.other == ticket_id:
        raise HTTPException(422, "A ticket can't link to itself")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'edit_props')
        with conn.cursor() as cur:
            src = helpers.ticket_or_404(cur, ticket_id)
            dst = helpers.ticket_or_404(cur, body.other)
            if src[4] or dst[4]:
                raise HTTPException(422, "Merged tickets can't be linked")
            if body.kind == "related":
                cur.execute("""SELECT 1 FROM desk.ticket_links
                                WHERE kind = 'related' AND voided_at IS NULL
                                  AND ((src_id = %s AND dst_id = %s)
                                    OR (src_id = %s AND dst_id = %s))""",
                            (ticket_id, body.other, body.other, ticket_id))
                if cur.fetchone():
                    raise HTTPException(409, "Already linked")
                cur.execute("""INSERT INTO desk.ticket_links (kind, src_id, dst_id, created_by)
                               VALUES ('related', %s, %s, %s) RETURNING id""",
                            (ticket_id, body.other, who['label']))
                (lid,) = cur.fetchone()
                detail = f"#{ticket_id} \u2194 #{body.other} (related)"
            else:
                my_parent = live_parent_of(cur, ticket_id)
                if my_parent is not None:
                    raise HTTPException(409, f"#{ticket_id} is a child of #{my_parent} — "
                                        "a child ticket can't be a parent")
                cur.execute("""SELECT 1 FROM desk.ticket_links
                                WHERE kind = 'child' AND voided_at IS NULL
                                  AND src_id = %s LIMIT 1""", (body.other,))
                if cur.fetchone():
                    raise HTTPException(409, f"#{body.other} already has children — "
                                        "it can't become a child")
                their_parent = live_parent_of(cur, body.other)
                if their_parent is not None:
                    raise HTTPException(409, f"#{body.other} is already a child of #{their_parent}")
                cur.execute("""INSERT INTO desk.ticket_links (kind, src_id, dst_id, created_by)
                               VALUES ('child', %s, %s, %s) RETURNING id""",
                            (ticket_id, body.other, who['label']))
                (lid,) = cur.fetchone()
                sys_note(cur, ticket_id, f"Child ticket linked: #{body.other}")
                sys_note(cur, body.other, f"Linked as a child of #{ticket_id}")
                detail = f"#{ticket_id} \u2192 child #{body.other}"
        auth.audit(conn, "desk", "Tickets linked", f"ticket:{ticket_id}",
                   f"{detail} ({who['label']})")
        return {"id": str(lid)}


class UnlinkSpec(BaseModel):
    kind: Literal["related", "child"]
    other: int


@router.post("/tickets/{ticket_id}/unlink")
def unlink_tickets(ticket_id: int, body: UnlinkSpec, request: Request):
    """Void a link (no DELETE — history survives). Works from either side."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'edit_props')
        with conn.cursor() as cur:
            helpers.ticket_or_404(cur, ticket_id)
            cur.execute("""UPDATE desk.ticket_links
                              SET voided_at = now(), voided_by = %s
                            WHERE kind = %s AND voided_at IS NULL
                              AND ((src_id = %s AND dst_id = %s)
                                OR (src_id = %s AND dst_id = %s))
                            RETURNING id""",
                        (who['label'], body.kind,
                         ticket_id, body.other, body.other, ticket_id))
            if cur.fetchone() is None:
                raise HTTPException(404, "No such live link")
        auth.audit(conn, "desk", "Tickets unlinked", f"ticket:{ticket_id}",
                   f"#{ticket_id} \u21f8 #{body.other} ({body.kind}, {who['label']})")
        return {"ok": True}


class CascadeSpec(BaseModel):
    version: int        # parent's optimistic lock, from your last read
    state: str = "Closed"   # the PARENT's target state — must be done-kind


@router.post("/tickets/{ticket_id}/close-cascade")
def close_cascade(ticket_id: int, body: CascadeSpec, request: Request):
    """Close a parent and all its open children in ONE transaction (bug #33's
    lesson: no partial ghosts). Children land in the system state
    'Closed: child ticket' — a done-kind state that close-email triggers
    ("state → Closed/Solved") never match, so no per-child close mail fires.
    Each child still gets a normal 'state' event, so automations aimed at the
    child state on purpose do run."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'close')
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            if row[4]:
                raise HTTPException(409, "Merged tickets can't be closed")
            cur.execute("""SELECT id, kind, is_system FROM desk.ticket_states
                            WHERE lower(label) = lower(%s) AND active""", (body.state,))
            strow = cur.fetchone()
            if strow is None:
                raise HTTPException(404, "Unknown state")
            if strow[1] != 'done' or strow[2]:
                raise HTTPException(422, "The parent must close into a normal resolved state")
            cur.execute("""SELECT id FROM desk.ticket_states
                            WHERE is_system AND active AND kind = 'done'
                            ORDER BY position LIMIT 1""")
            cc = cur.fetchone()
            if cc is None:
                raise HTTPException(409, "System close state missing — run migration 0025")
            (ccid,) = cc
            cur.execute("""SELECT l.dst_id FROM desk.ticket_links l
                             JOIN desk.tickets c ON c.id = l.dst_id
                             JOIN desk.ticket_states s ON s.id = c.state_id
                            WHERE l.kind = 'child' AND l.voided_at IS NULL
                              AND l.src_id = %s AND s.kind <> 'done'
                              AND c.merged_into_id IS NULL
                            ORDER BY l.dst_id""", (ticket_id,))
            kids = [r[0] for r in cur.fetchall()]
            cur.execute("""UPDATE desk.tickets SET state_id = %s, pending_until = NULL
                            WHERE id = %s AND version = %s RETURNING version""",
                        (strow[0], ticket_id, body.version))
            updated = cur.fetchone()
            if updated is None:
                raise HTTPException(409, "Version conflict — re-read the ticket and retry")
            emit_event(cur, "state", ticket_id)
            for cid in kids:
                # pending cleared like every close path (merge.py invariant) —
                # a cascade-closed on-hold child must not be worker-reopened
                cur.execute("""UPDATE desk.tickets SET state_id = %s,
                                      pending_until = NULL WHERE id = %s""",
                            (ccid, cid))
                sys_note(cur, cid, f"Closed with parent #{ticket_id} ({body.state})")
                emit_event(cur, "state", cid)
                auth.audit(conn, "desk", "Ticket closed by parent cascade",
                           f"ticket:{cid}", f"#{cid} · parent #{ticket_id} ({who['label']})")
            if kids:
                sys_note(cur, ticket_id,
                         f"Closed with {len(kids)} child ticket{'' if len(kids) == 1 else 's'}: "
                         + ", ".join(f"#{k}" for k in kids))
        auth.audit(conn, "desk", "Ticket closed with children", f"ticket:{ticket_id}",
                   f"#{ticket_id} → {body.state} · children: "
                   + (", ".join(f"#{k}" for k in kids) or "none open")
                   + f" ({who['label']})")
        return {"ok": True, "closed_children": kids, "version": updated[0]}
