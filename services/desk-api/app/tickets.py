"""Ticket surface. Reads mirror window.DocketAPI; writes cover the working
loop: props (optimistic-locked), tags, pending wakes, and transactional merge
(HANDOFF §10.11). Locked projects refuse everything (423)."""
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from pydantic import BaseModel
from . import auth, db, helpers

router = APIRouter(prefix="/api")

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
        auth.audit(conn, "desk", "Ticket created", f"ticket:{ticket_id}",
                   f"#{ticket_id} {body.title} — via API ({who['label']})")
        return {"id": ticket_id}


class PatchTicket(BaseModel):
    version: int                       # optimistic lock — from your last read
    title: str | None = None
    state: str | None = None
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
            if body.title is not None:
                sets.append("title = %s"); args.append(body.title); notes.append("title")
            if body.state is not None:
                sets.append("state_id = %s"); args.append(helpers.state_id(cur, body.state))
                notes.append(f"state → {body.state}")
            if body.priority is not None:
                sets.append("priority_id = %s"); args.append(helpers.priority_id(cur, body.priority))
                notes.append(f"priority → {body.priority}")
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
        auth.audit(conn, "desk", "Ticket updated", f"ticket:{ticket_id}",
                   f"#{ticket_id} · " + " · ".join(notes))
        return {"ok": True, "changed": notes, "version": updated[0]}


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


class MergeSpec(BaseModel):
    into: int


@router.post("/tickets/{ticket_id}/merge")
def merge(ticket_id: int, body: MergeSpec, request: Request):
    """Transactional merge (§10.11): thread + open-period time + tags + cc move
    to the target; the source becomes a closed stub pointing at it. Entries in
    approved/exported periods are already billed under the source number and
    stay put (the DB would refuse anyway) — noted in the sys article.
    Merging INTO a project is refused: project time must sit under a task."""
    if body.into == ticket_id:
        raise HTTPException(422, "Cannot merge a ticket into itself")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'edit_props')
        with conn.cursor() as cur:
            src = helpers.ticket_or_404(cur, ticket_id)
            dst = helpers.ticket_or_404(cur, body.into)
            helpers.refuse_if_locked_project(src)
            if src[4]:
                raise HTTPException(409, "Source is already merged")
            if dst[2]:
                raise HTTPException(422, "Cannot merge into a project ticket — its time needs tasks")
            cur.execute("UPDATE desk.articles SET ticket_id = %s WHERE ticket_id = %s",
                        (body.into, ticket_id))
            moved_articles = cur.rowcount
            cur.execute("""UPDATE ledger.time_entries e SET ticket_id = %s
                            FROM ledger.billing_periods bp
                           WHERE bp.id = e.period_id AND bp.status = 'open'
                             AND e.ticket_id = %s""", (body.into, ticket_id))
            moved_time = cur.rowcount
            cur.execute("SELECT count(*) FROM ledger.time_entries WHERE ticket_id = %s",
                        (ticket_id,))
            (stayed,) = cur.fetchone()
            cur.execute("""INSERT INTO desk.ticket_tags (ticket_id, tag)
                           SELECT %s, tag FROM desk.ticket_tags WHERE ticket_id = %s
                           ON CONFLICT DO NOTHING""", (body.into, ticket_id))
            cur.execute("DELETE FROM desk.ticket_tags WHERE ticket_id = %s", (ticket_id,))
            cur.execute("""UPDATE desk.tickets d
                              SET cc = (SELECT array(SELECT DISTINCT x FROM unnest(d.cc || s.cc) x))
                             FROM desk.tickets s
                            WHERE d.id = %s AND s.id = %s""", (body.into, ticket_id))
            cur.execute("""UPDATE desk.tickets
                              SET merged_into_id = %s, state_id = %s, pending_until = NULL
                            WHERE id = %s""",
                        (body.into, helpers.state_id(cur, "Closed"), ticket_id))
            note = (f"Merged from #{ticket_id}: {moved_articles} articles, "
                    f"{moved_time} time entries moved"
                    + (f"; {stayed} stayed (billed in locked periods)" if stayed else ""))
            cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, body)
                           VALUES (%s, 'sys', 'Automation', %s)""", (body.into, note))
            cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, body)
                           VALUES (%s, 'sys', 'Automation',
                                   %s)""",
                        (ticket_id, f"Merged into #{body.into} — this ticket is a closed stub"))
            cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id IN (%s, %s)",
                        (ticket_id, body.into))
        auth.audit(conn, "desk", "Ticket merged", f"ticket:{ticket_id}",
                   f"#{ticket_id} → #{body.into} · {note}")
        return {"ok": True, "moved_articles": moved_articles,
                "moved_time_entries": moved_time, "locked_entries_kept": stayed}


class TimeSpec(BaseModel):
    started_at: str
    ended_at: str
    activity_type: str
    technician_email: str
    task_id: str | None = None


class NewArticle(BaseModel):
    kind: str
    body: str
    author_email: str
    time: TimeSpec | None = None


@router.post("/tickets/{ticket_id}/articles", status_code=201)
def add_article(ticket_id: int, body: NewArticle, request: Request):
    if body.kind not in ("reply", "note"):
        raise HTTPException(422, "kind must be reply or note")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "reply" if body.kind == "reply" else "note")
        if body.time:
            auth.need(who, "log_time")
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            client_id = row[1]
            author_id, author_name = helpers.agent(cur, body.author_email)
            cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, author_id, body)
                           VALUES (%s, %s, %s, %s, %s) RETURNING id""",
                        (ticket_id, body.kind, author_name, author_id, body.body))
            (article_id,) = cur.fetchone()
            entry_id, hours = None, None
            if body.time:
                t = body.time
                tech_id, _ = helpers.agent(cur, t.technician_email)
                type_id = helpers.activity_type_id(cur, t.activity_type)
                cur.execute("""INSERT INTO ledger.time_entries
                                 (ticket_id, task_id, client_id, tech_id, activity_type_id,
                                  started_at, ended_at, note)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id, hours""",
                            (ticket_id, t.task_id, client_id, tech_id, type_id,
                             t.started_at, t.ended_at, body.body[:140]))
                entry_id, hours = cur.fetchone()
            cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s", (ticket_id,))
        detail = f"#{ticket_id} · {body.kind} by {author_name}"
        if entry_id:
            detail += f" · {hours} h → Ledger"
        auth.audit(conn, "desk", "Reply sent" if body.kind == "reply" else "Note added",
                   f"ticket:{ticket_id}", detail)
        return {"article_id": str(article_id),
                "time_entry_id": str(entry_id) if entry_id else None}
