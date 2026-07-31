"""Ticket reads — the window.DocketAPI mirror (list + detail), the queue
report, and the audit tail."""
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from .. import auth, db
from .common import TICKET_SELECT

router = APIRouter(prefix="/api")


@router.get("/tickets")
def list_tickets(request: Request, state: str | None = None, client: str | None = None,
                 limit: int = 100):
    with db.connect() as conn:
        auth.require(conn, request)
        where, args = [], []
        if state:
            where.append("(lower(s.label) = lower(%s) OR s.kind = lower(%s))")
            args += [state, state]
        if client:
            where.append("(c.name = %s OR c.id::text = %s)")
            args += [client, client]
        sql = TICKET_SELECT + (" WHERE " + " AND ".join(where) if where else "")
        sql += " ORDER BY t.updated_at DESC LIMIT %s"
        args.append(min(limit, 500))
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, args)
            return {"tickets": cur.fetchall()}


@router.get("/tickets/{ticket_id}")
def get_ticket(ticket_id: int, request: Request):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(TICKET_SELECT + " WHERE t.id = %s", (ticket_id,))
            ticket = cur.fetchone()
            if ticket is None:
                raise HTTPException(404, "No such ticket")
            cur.execute(
                """SELECT id, kind, author, mail_from, mail_to, mail_cc,
                          body, is_auto, sent_at,
                          (SELECT count(*) FROM desk.attachments at
                            WHERE at.article_id = ar.id) AS attachments
                     FROM desk.articles ar
                    WHERE ar.ticket_id = %s ORDER BY sent_at""", (ticket_id,))
            ticket["articles"] = cur.fetchall()
            cur.execute(
                """SELECT e.id, e.started_at, e.ended_at, e.hours,
                          a.name AS technician, at.name AS activity_type,
                          e.task_id, e.status,
                          e.submitted_at IS NOT NULL AS submitted,
                          e.ts_approved_at IS NOT NULL AS ts_approved
                     FROM ledger.time_entries e
                     JOIN shared.agents a ON a.id = e.tech_id
                     JOIN ledger.activity_types at ON at.id = e.activity_type_id
                    WHERE e.ticket_id = %s ORDER BY e.started_at""", (ticket_id,))
            ticket["time"] = cur.fetchall()
            if ticket["is_project"]:
                cur.execute(
                    """SELECT status, billing_model, project_flat_cents, unlocked, approved_at
                         FROM desk.projects WHERE ticket_id = %s""", (ticket_id,))
                ticket["project"] = cur.fetchone() or {}
                cur.execute(
                    """SELECT id, label, position, done_at IS NOT NULL AS done,
                              billing_mode, rate_cents, flat_cents
                         FROM desk.project_tasks WHERE ticket_id = %s ORDER BY position""",
                    (ticket_id,))
                ticket["project"]["tasks"] = cur.fetchall()
            return ticket


@router.get("/reports/queue")
def report_queue(request: Request):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor(row_factory=dict_row) as cur:
            out = {}
            for name, col in (("by_state", "s.kind"), ("by_group", "g.name"),
                              ("by_priority", "p.label")):
                cur.execute(f"""
                    SELECT {col} AS key, count(*) AS n
                      FROM desk.tickets t
                      JOIN desk.ticket_states s ON s.id = t.state_id
                      JOIN desk.priorities p    ON p.id = t.priority_id
                      JOIN shared.groups g      ON g.id = t.group_id
                     WHERE s.kind <> 'done'
                     GROUP BY 1 ORDER BY n DESC""")
                out[name] = cur.fetchall()
            return out


@router.get("/audit")
def get_audit(request: Request, limit: int = 100):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'view_audit')
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""SELECT at, actor, app, action, entity, detail
                             FROM audit.events ORDER BY at DESC LIMIT %s""",
                        (min(limit, 1000),))
            return {"events": cur.fetchall()}
