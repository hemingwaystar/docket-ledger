"""desk-api — Docket's backend.

Read surface mirrors the prototype's window.DocketAPI 1:1:
  GET /api/tickets?state=&client=     state = label or kind; client = uuid or name
  GET /api/tickets/{id}               full thread, time, tags, project, pending_until
  GET /api/reports/queue              open counts by state kind / group / priority
  GET /api/audit?limit=

Write paths for the core loop:
  POST /api/tickets                   {title, client, group, contact_email?, priority?}
  POST /api/tickets/{id}/articles     {kind: reply|note, body, author_email,
                                       time?: {started_at, ended_at, activity_type,
                                               technician_email, task_id?}}

Auth: Bearer PAT (app/auth.py). Time writes lean on the DB triggers — period
assignment, project-task requirement, immutability — so this layer stays thin."""
from fastapi import FastAPI, HTTPException, Request
from psycopg.rows import dict_row
from pydantic import BaseModel
from . import auth, db

app = FastAPI(title="desk-api", root_path="/desk")


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/readyz")
def readyz():
    with db.connect("system") as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM desk.ticket_states")
        (states,) = cur.fetchone()
    return {"ok": True, "ticket_states": states}


TICKET_SELECT = """
  SELECT t.id, t.title, s.label AS state, s.kind AS state_kind,
         p.label AS priority, c.name AS client, g.name AS "group",
         a.name AS owner, t.pending_until, t.merged_into_id,
         t.is_project, t.created_at, t.updated_at, t.version,
         COALESCE((SELECT array_agg(tag ORDER BY tag)
                     FROM desk.ticket_tags tt WHERE tt.ticket_id = t.id), '{}') AS tags
    FROM desk.tickets t
    JOIN desk.ticket_states s ON s.id = t.state_id
    JOIN desk.priorities p    ON p.id = t.priority_id
    JOIN shared.clients c     ON c.id = t.client_id
    JOIN shared.groups g      ON g.id = t.group_id
    LEFT JOIN shared.agents a ON a.id = t.owner_id
"""


@app.get("/api/tickets")
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


@app.get("/api/tickets/{ticket_id}")
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
                    WHERE ar.ticket_id = %s ORDER BY sent_at""",
                (ticket_id,),
            )
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
                    WHERE e.ticket_id = %s ORDER BY e.started_at""",
                (ticket_id,),
            )
            ticket["time"] = cur.fetchall()
            if ticket["is_project"]:
                cur.execute(
                    """SELECT p.status, p.billing_model, p.project_flat_cents,
                              p.unlocked, p.approved_at
                         FROM desk.projects p WHERE p.ticket_id = %s""",
                    (ticket_id,),
                )
                ticket["project"] = cur.fetchone() or {}
                cur.execute(
                    """SELECT id, label, position, done_at IS NOT NULL AS done,
                              billing_mode, rate_cents, flat_cents
                         FROM desk.project_tasks
                        WHERE ticket_id = %s ORDER BY position""",
                    (ticket_id,),
                )
                ticket["project"]["tasks"] = cur.fetchall()
            return ticket


@app.get("/api/reports/queue")
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


@app.get("/api/audit")
def get_audit(request: Request, limit: int = 100):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """SELECT at, actor, app, action, entity, detail
                     FROM audit.events ORDER BY at DESC LIMIT %s""",
                (min(limit, 1000),),
            )
            return {"events": cur.fetchall()}


class NewTicket(BaseModel):
    title: str
    client: str            # name or uuid
    group: str             # name or uuid
    contact_email: str | None = None
    priority: str = "Normal"


@app.post("/api/tickets", status_code=201)
def create_ticket(body: NewTicket, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM shared.clients WHERE name = %s OR id::text = %s",
                        (body.client, body.client))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, "Unknown client")
            client_id = row[0]
            cur.execute("SELECT id FROM shared.groups WHERE name = %s OR id::text = %s",
                        (body.group, body.group))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, "Unknown group")
            group_id = row[0]
            cur.execute("SELECT id FROM desk.priorities WHERE lower(label) = lower(%s)",
                        (body.priority,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, "Unknown priority")
            priority_id = row[0]
            contact_id = None
            if body.contact_email:
                cur.execute("SELECT id FROM shared.contacts WHERE lower(email) = lower(%s)",
                            (body.contact_email,))
                row = cur.fetchone()
                contact_id = row[0] if row else None
            cur.execute(
                """INSERT INTO desk.tickets
                     (title, client_id, contact_id, group_id, state_id, priority_id)
                   VALUES (%s, %s, %s, %s,
                     (SELECT id FROM desk.ticket_states WHERE label = 'New'), %s)
                   RETURNING id""",
                (body.title, client_id, contact_id, group_id, priority_id),
            )
            (ticket_id,) = cur.fetchone()
        auth.audit(conn, "desk", "Ticket created",
                   f"ticket:{ticket_id}",
                   f"#{ticket_id} {body.title} — via API ({who['label']})")
        return {"id": ticket_id}


class TimeSpec(BaseModel):
    started_at: str        # ISO timestamptz
    ended_at: str
    activity_type: str     # name or uuid
    technician_email: str
    task_id: str | None = None


class NewArticle(BaseModel):
    kind: str              # 'reply' | 'note'
    body: str
    author_email: str
    time: TimeSpec | None = None


@app.post("/api/tickets/{ticket_id}/articles", status_code=201)
def add_article(ticket_id: int, body: NewArticle, request: Request):
    if body.kind not in ("reply", "note"):
        raise HTTPException(422, "kind must be reply or note")
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor() as cur:
            cur.execute("SELECT client_id FROM desk.tickets WHERE id = %s", (ticket_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(404, "No such ticket")
            client_id = row[0]
            cur.execute("SELECT id, name FROM shared.agents WHERE lower(email) = lower(%s)",
                        (body.author_email,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, "Unknown author agent")
            author_id, author_name = row
            cur.execute(
                """INSERT INTO desk.articles (ticket_id, kind, author, author_id, body)
                   VALUES (%s, %s, %s, %s, %s) RETURNING id""",
                (ticket_id, body.kind, author_name, author_id, body.body),
            )
            (article_id,) = cur.fetchone()
            entry_id, hours = None, None
            if body.time:
                t = body.time
                cur.execute("SELECT id FROM shared.agents WHERE lower(email) = lower(%s)",
                            (t.technician_email,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(422, "Unknown technician")
                tech_id = row[0]
                cur.execute("SELECT id FROM ledger.activity_types WHERE name = %s OR id::text = %s",
                            (t.activity_type, t.activity_type))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(422, "Unknown activity type")
                type_id = row[0]
                # triggers do the rest: period assignment + project-task guard
                cur.execute(
                    """INSERT INTO ledger.time_entries
                         (ticket_id, task_id, client_id, tech_id, activity_type_id,
                          started_at, ended_at, note)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id, hours""",
                    (ticket_id, t.task_id, client_id, tech_id, type_id,
                     t.started_at, t.ended_at, body.body[:140]),
                )
                entry_id, hours = cur.fetchone()
            cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s",
                        (ticket_id,))
        detail = f"#{ticket_id} · {body.kind} by {author_name}"
        if entry_id:
            detail += f" · {hours} h → Ledger"
        auth.audit(conn, "desk",
                   "Reply sent" if body.kind == "reply" else "Note added",
                   f"ticket:{ticket_id}", detail)
        return {"article_id": str(article_id),
                "time_entry_id": str(entry_id) if entry_id else None}
