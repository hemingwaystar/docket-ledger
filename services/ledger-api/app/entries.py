"""Time entries — the tech half of the timesheet chain:
  PATCH /api/entries/{id}             reclassify, span edit (pre-submission), void
  POST /api/entries/{id}/recall       pull a submission back (until approval)
  GET /api/entries?client=&status=    status: pending|submitted|approved|locked|void
  POST /api/entries/{id}/submit
Reads are priced by the ONE SQL pricing ladder (ledger.priced) so nothing
here can disagree with exports; the DB freeze guard has the final word."""
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from psycopg import errors as pg_errors
from pydantic import BaseModel
from . import auth, db
from .helpers import _sane_span, entry_scope_where

router = APIRouter()


class Classify(BaseModel):
    activity_type: str | None = None
    started_at: str | None = None      # span edits — pre-submission only
    ended_at: str | None = None
    void: bool | None = None           # removed-in-Docket semantics; never delete
    void_reason: str = ""


@router.patch("/api/entries/{entry_id}")
def classify_entry(entry_id: str, body: Classify, request: Request):
    """Entry edits from the Ledger UI: reclassify or adjust the span
    (pre-submission), or void. Approved/period-locked rows: the DB freeze
    guard (SECURITY DEFINER since 0012) refuses and we return 409."""
    _sane_span(body.started_at, body.ended_at)
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_edit_own", "l_edit_all")
        with conn.cursor() as cur:
            sets, args, notes = [], [], []
            if body.activity_type is not None:
                cur.execute("SELECT id FROM ledger.activity_types WHERE name = %s OR id::text = %s",
                            (body.activity_type, body.activity_type))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(422, "Unknown activity type")
                sets.append("activity_type_id = %s"); args.append(row[0])
                notes.append(f"type → {body.activity_type}")
            if body.started_at is not None:
                sets.append("started_at = %s"); args.append(body.started_at)
            if body.ended_at is not None:
                sets.append("ended_at = %s"); args.append(body.ended_at)
            if body.started_at is not None or body.ended_at is not None:
                notes.append("span edited")
            if body.void:
                sets += ["status = 'void'", "voided_at = now()", "void_reason = %s"]
                args.append(body.void_reason or "removed in Ledger")
                notes.append("voided")
            if not sets:
                return {"ok": True, "changed": []}
            # span/type edits stop at submission — unless the role holds
            # l_edit_submitted (audit: the permission is now real server-side);
            # a void is allowed until manager approval. l_edit_own without
            # l_edit_all reaches OWN rows only — the same rule the UI's
            # canEditEntry applies. The freeze guard has the final word.
            gate = ("AND ts_approved_at IS NULL" if body.void
                    else "AND status = 'pending' AND ts_approved_at IS NULL")
            gargs = []
            if who["kind"] == "session":
                if "l_edit_submitted" not in who["perms"]:
                    gate += " AND submitted_at IS NULL"
                if "l_edit_all" not in who["perms"]:
                    gate += " AND tech_id = %s"
                    gargs.append(who["agent_id"])
            try:
                cur.execute(f"""UPDATE ledger.time_entries SET {', '.join(sets)}
                                 WHERE id = %s {gate}
                               RETURNING id""", (*args, entry_id, *gargs))
            except pg_errors.RaiseException as e:
                raise HTTPException(409, e.diag.message_primary or "Entry is immutable")
            if cur.fetchone() is None:
                raise HTTPException(409, "Entry missing, not yours to edit, "
                                         "submitted, approved, or immutable")
        auth.audit(conn, "ledger", "Entry updated", f"entry:{entry_id}",
                   " · ".join(notes) + f" ({who['label']})")
        return {"ok": True, "changed": notes}


@router.post("/api/entries/{entry_id}/recall")
def recall_entry(entry_id: str, request: Request):
    """A tech pulls their own submission back for edits — the reverse of
    submit, legal until a manager approves."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'l_submit')
        with conn.cursor() as cur:
            # own sheet only, unless l_edit_all (audit: bare l_submit could
            # recall anyone's submission)
            own, oargs = "", []
            if who["kind"] == "session" and "l_edit_all" not in who["perms"]:
                own, oargs = " AND tech_id = %s", [who["agent_id"]]
            cur.execute(f"""UPDATE ledger.time_entries
                              SET submitted_at = NULL
                            WHERE id = %s AND submitted_at IS NOT NULL
                              AND ts_approved_at IS NULL AND status = 'pending'{own}
                           RETURNING id""", (entry_id, *oargs))
            if cur.fetchone() is None:
                raise HTTPException(409, "Entry missing, not yours, not submitted, "
                                         "or already approved")
        auth.audit(conn, "ledger", "Submission recalled", f"entry:{entry_id}",
                   f"via API ({who['label']})")
        return {"ok": True}


ENTRY_SELECT = """
  SELECT e.id, e.ticket_id, e.task_id, c.name AS client, a.name AS technician,
         a.email AS technician_email,
         at.name AS activity_type, e.started_at, e.ended_at, e.hours, e.note,
         bp.period_key, bp.status AS period_status,
         p.rate_cents, p.amount_cents, p.billable, p.covered_by_project_flat,
         CASE WHEN e.status = 'void' THEN 'void'
              WHEN bp.status <> 'open' THEN 'locked'
              WHEN e.ts_approved_at IS NOT NULL THEN 'approved'
              WHEN e.submitted_at IS NOT NULL THEN 'submitted'
              ELSE 'pending' END AS status,
         e.return_reason, e.version
    FROM ledger.time_entries e
    CROSS JOIN LATERAL ledger.priced(e) AS p
    JOIN shared.clients c ON c.id = e.client_id
    JOIN shared.agents a  ON a.id = e.tech_id
    JOIN ledger.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN ledger.billing_periods bp ON bp.id = e.period_id
"""


@router.get("/api/entries")
def list_entries(request: Request, client: str | None = None, status: str | None = None,
                 limit: int = 200):
    with db.connect() as conn:
        who = auth.require(conn, request)
        scope_sql, scope_args = entry_scope_where(who)
        sql, args = ENTRY_SELECT, list(scope_args)
        where = [scope_sql]
        if client:
            where.append("(c.name = %s OR c.id::text = %s)")
            args += [client, client]
        sql += " WHERE " + " AND ".join(where)
        # the status filter runs in SQL, BEFORE the limit (audit: filtering
        # the newest N rows in Python silently dropped older matches)
        if status:
            if status not in ("pending", "submitted", "approved", "locked", "void"):
                raise HTTPException(422, "status must be pending, submitted, "
                                         "approved, locked, or void")
            sql = f"SELECT * FROM ({sql}) sub WHERE sub.status = %s"
            args.append(status)
        sql += " ORDER BY started_at DESC LIMIT %s"
        args.append(min(limit, 1000))
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, args)
            rows = cur.fetchall()
        # money visibility (audit): rates/amounts ship only with l_see_amounts
        if who["kind"] == "session" and "l_see_amounts" not in who["perms"]:
            for r in rows:
                r["rate_cents"] = None
                r["amount_cents"] = None
        return {"entries": rows}


@router.post("/api/entries/{entry_id}/submit")
def submit_entry(entry_id: str, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'l_submit')
        with conn.cursor() as cur:
            # own entries only, unless l_edit_all — mirrors canSubmitEntry
            own, oargs = "", []
            if who["kind"] == "session" and "l_edit_all" not in who["perms"]:
                own, oargs = " AND tech_id = %s", [who["agent_id"]]
            cur.execute(f"""
                UPDATE ledger.time_entries
                   SET submitted_at = now(),
                       returned_at = NULL, returned_by = NULL, return_reason = NULL
                 WHERE id = %s AND status = 'pending' AND submitted_at IS NULL{own}
                   AND activity_type_id <> (SELECT id FROM ledger.activity_types WHERE is_sentinel)
                RETURNING id""", (entry_id, *oargs))
            if cur.fetchone() is None:
                raise HTTPException(409, "Entry missing, not yours, already submitted, "
                                         "voided, or unclassified")
        auth.audit(conn, "ledger", "Submitted for review", f"entry:{entry_id}", "via API")
        return {"ok": True}
