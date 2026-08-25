"""Time from the ticket view: add an entry (standalone or riding a note),
edit or void. The DB freeze guard (approved timesheets, closed periods —
0012) is the real gate."""
from fastapi import APIRouter, HTTPException, Request
from psycopg import errors as pg_errors
from pydantic import BaseModel
from .. import auth, db, helpers
from .common import _sane_span
from .write import _touch

router = APIRouter(prefix="/api")


class NewTime(BaseModel):
    started_at: str
    ended_at: str
    activity_type: str
    technician_email: str
    article_id: str | None = None      # ride on an existing note/reply
    task_id: str | None = None
    note: str = ""


@router.post("/tickets/{ticket_id}/time", status_code=201)
def add_time(ticket_id: int, body: NewTime, request: Request):
    """A standalone or article-attached time entry — the '+ time' button on an
    existing note. Composer-attached time still travels with its article."""
    _sane_span(getattr(body, 'started_at', None), getattr(body, 'ended_at', None))
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'log_time')
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            client_id = row[1]
            tech_id, tech_name = helpers.agent(cur, body.technician_email)
            type_id = helpers.activity_type_id(cur, body.activity_type)
            if body.article_id:
                cur.execute("""SELECT 1 FROM desk.articles
                                WHERE id = %s AND ticket_id = %s
                                  AND kind IN ('note', 'reply')""",
                            (body.article_id, ticket_id))
                if cur.fetchone() is None:
                    raise HTTPException(422, "Article not on this ticket (or not a note/reply)")
            try:
                cur.execute("""INSERT INTO ledger.time_entries
                                 (ticket_id, task_id, client_id, tech_id, activity_type_id,
                                  started_at, ended_at, note, article_id)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                               RETURNING id, hours""",
                            (ticket_id, body.task_id, client_id, tech_id, type_id,
                             body.started_at, body.ended_at, body.note[:140], body.article_id))
            except pg_errors.RaiseException as e:   # 0039 insert guard: period closed
                raise HTTPException(409, e.diag.message_primary or "Billing period is closed")
            entry_id, hours = cur.fetchone()
            # _touch, not a bare UPDATE: the bump must ride back to the client
            # or its next property edit 409s on the stale version (audit;
            # build 14b / 16 F1's class)
            version, updated_ms = _touch(cur, ticket_id)
        auth.audit(conn, "desk", "Time attached", f"ticket:{ticket_id}",
                   f"#{ticket_id} · {tech_name} · {hours} h · {body.activity_type}"
                   + (" · on article" if body.article_id else ""))
        return {"id": str(entry_id), "hours": float(hours),
                "version": version, "updatedAt": updated_ms}


class PatchTime(BaseModel):
    started_at: str | None = None
    ended_at: str | None = None
    activity_type: str | None = None
    task_id: str | None = None         # "" clears
    void: bool | None = None           # remove-from-ticket = void, never delete
    void_reason: str = ""


@router.patch("/time/{entry_id}")
def patch_time(entry_id: str, body: PatchTime, request: Request):
    """Edit or void a time entry from the ticket view. Own entries need
    log_time; someone else's need see_billing. The DB freeze guard (approved
    timesheets, closed periods — SECURITY DEFINER as of 0012) still fires."""
    _sane_span(getattr(body, 'started_at', None), getattr(body, 'ended_at', None))
    with db.connect() as conn:
        who = auth.require(conn, request)
        with conn.cursor() as cur:
            cur.execute("""SELECT e.tech_id, e.ticket_id, e.hours
                             FROM ledger.time_entries e WHERE e.id = %s""", (entry_id,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such time entry")
            tech_id, ticket_id, old_hours = row
            if who["kind"] == "session" and tech_id != who["agent_id"]:
                auth.need(who, 'see_billing')
            else:
                auth.need(who, 'log_time', 'see_billing')
            if ticket_id is not None:
                trow = helpers.ticket_or_404(cur, ticket_id)
                helpers.refuse_if_locked_project(trow)
            sets, args, notes = [], [], []
            if body.started_at is not None:
                sets.append("started_at = %s"); args.append(body.started_at)
            if body.ended_at is not None:
                sets.append("ended_at = %s"); args.append(body.ended_at)
            if body.started_at is not None or body.ended_at is not None:
                notes.append("span edited")
            if body.activity_type is not None:
                sets.append("activity_type_id = %s")
                args.append(helpers.activity_type_id(cur, body.activity_type))
                notes.append(f"type → {body.activity_type}")
            if body.task_id is not None:
                if body.task_id == "":
                    sets.append("task_id = NULL"); notes.append("task cleared")
                else:
                    sets.append("task_id = %s"); args.append(body.task_id)
                    notes.append("task moved")
            if body.void:
                sets += ["status = 'void'", "voided_at = now()", "void_reason = %s"]
                args.append(body.void_reason or "removed from ticket")
                notes.append("voided")
            if not sets:
                return {"ok": True, "changed": []}
            try:
                cur.execute(f"""UPDATE ledger.time_entries SET {', '.join(sets)}
                                 WHERE id = %s AND ts_approved_at IS NULL
                               RETURNING hours""", (*args, entry_id))
            except pg_errors.RaiseException as e:   # the freeze guard said no
                raise HTTPException(409, e.diag.message_primary or "Entry is immutable")
            updated = cur.fetchone()
            if updated is None:
                raise HTTPException(409, "Entry is manager-approved — revoke the timesheet approval first")
        auth.audit(conn, "desk", "Time entry updated",
                   f"entry:{entry_id}",
                   (f"#{ticket_id} · " if ticket_id else "") + " · ".join(notes)
                   + f" · {old_hours} → {updated[0]} h")
        return {"ok": True, "changed": notes, "hours": float(updated[0])}
