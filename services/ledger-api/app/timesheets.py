"""The timesheet chain, manager side — one (tech_email, client, period_key)
sheet per call:
  POST /api/timesheets/return     kick submitted-not-approved entries back
  POST /api/timesheets/revoke     undo an approval (pre period-lock)
  POST /api/timesheets/approve    the sign-off — freezes every entry
DB triggers enforce the freeze; their refusals surface as 409."""
from fastapi import APIRouter, HTTPException, Request
from psycopg import errors as pg_errors
from pydantic import BaseModel
from . import auth, db

router = APIRouter()


class ReturnSheet(BaseModel):
    tech_email: str
    client: str
    period_key: str
    reason: str = ""


@router.post("/api/timesheets/return")
def return_timesheet(body: ReturnSheet, request: Request):
    """Send a (tech, client, period) sheet back: submitted-not-approved entries
    unsubmit with the reason stamped on each (the tech-visible kick-back)."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'l_approve')
        with conn.cursor() as cur:
            cur.execute("SELECT id, name FROM shared.agents WHERE lower(email) = lower(%s)",
                        (body.tech_email,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, "Unknown technician")
            tech_id, tech_name = row
            cur.execute("SELECT id FROM shared.clients WHERE name = %s OR id::text = %s",
                        (body.client, body.client))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, "Unknown client")
            client_id = row[0]
            try:
                cur.execute("""
                UPDATE ledger.time_entries e
                   SET submitted_at = NULL, returned_by = %s,
                       returned_at = now(), return_reason = NULLIF(%s, '')
                  FROM ledger.billing_periods bp
                 WHERE bp.id = e.period_id AND bp.status = 'open'
                   AND e.tech_id = %s AND e.client_id = %s AND bp.period_key = %s
                   AND e.status <> 'void'
                   AND e.submitted_at IS NOT NULL AND e.ts_approved_at IS NULL
                RETURNING e.id""",
                            (who.get("agent_id"), body.reason, tech_id,
                             client_id, body.period_key))
            except pg_errors.RaiseException as e:
                raise HTTPException(409, e.diag.message_primary or "Entries are period-locked")
            n = len(cur.fetchall())
            if n == 0:
                raise HTTPException(409, "Nothing to return on that sheet")
        auth.audit(conn, "ledger", "Timesheet returned",
                   f"timesheet:{tech_id}|{client_id}|{body.period_key}",
                   f"{n} entries back to {tech_name}"
                   + (f" — “{body.reason}”" if body.reason else "")
                   + f" ({who['label']})")
        return {"returned_entries": n}


class RevokeSheet(BaseModel):
    tech_email: str
    client: str
    period_key: str


@router.post("/api/timesheets/revoke")
def revoke_timesheet(body: RevokeSheet, request: Request):
    """Undo a manager approval (pre period-lock): entries back to Submitted."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'l_approve')
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM shared.agents WHERE lower(email) = lower(%s)",
                        (body.tech_email,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, "Unknown technician")
            tech_id = row[0]
            cur.execute("SELECT id FROM shared.clients WHERE name = %s OR id::text = %s",
                        (body.client, body.client))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, "Unknown client")
            client_id = row[0]
            try:
                cur.execute("""
                    UPDATE ledger.time_entries e
                       SET ts_approved_at = NULL, ts_approved_by = NULL
                      FROM ledger.billing_periods bp
                     WHERE bp.id = e.period_id AND bp.status = 'open'
                       AND e.tech_id = %s AND e.client_id = %s AND bp.period_key = %s
                       AND e.ts_approved_at IS NOT NULL
                    RETURNING e.id""", (tech_id, client_id, body.period_key))
            except pg_errors.RaiseException as e:
                raise HTTPException(409, e.diag.message_primary or "Entries are period-locked")
            n = len(cur.fetchall())
            if n == 0:
                raise HTTPException(409, "Nothing approved (or the period is locked)")
        auth.audit(conn, "ledger", "Timesheet approval revoked",
                   f"timesheet:{tech_id}|{client_id}|{body.period_key}",
                   f"{n} entries back to Submitted ({who['label']})")
        return {"revoked_entries": n}


class ApproveSheet(BaseModel):
    tech_email: str
    client: str            # name or uuid
    period_key: str        # '2026-07' / '2026-W31'


@router.post("/api/timesheets/approve")
def approve_timesheet(body: ApproveSheet, request: Request):
    """Approve one (tech, client, period) timesheet — the manager sign-off.
    Requires every live entry in the bundle submitted; freezes them (trigger-
    enforced) pending the period lock."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'l_approve')
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM shared.agents WHERE lower(email) = lower(%s)",
                        (body.tech_email,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, "Unknown technician")
            tech_id = row[0]
            cur.execute("SELECT id FROM shared.clients WHERE name = %s OR id::text = %s",
                        (body.client, body.client))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, "Unknown client")
            client_id = row[0]
            cur.execute("""
                SELECT count(*) FILTER (WHERE e.submitted_at IS NULL)
                  FROM ledger.time_entries e
                  JOIN ledger.billing_periods bp ON bp.id = e.period_id
                 WHERE e.tech_id = %s AND e.client_id = %s
                   AND bp.period_key = %s AND e.status <> 'void'""",
                (tech_id, client_id, body.period_key))
            (unsubmitted,) = cur.fetchone()
            if unsubmitted:
                raise HTTPException(409, f"{unsubmitted} entries not yet submitted")
            try:
                cur.execute("""
                    UPDATE ledger.time_entries e
                       SET ts_approved_at = now()
                      FROM ledger.billing_periods bp
                     WHERE bp.id = e.period_id
                       AND e.tech_id = %s AND e.client_id = %s AND bp.period_key = %s
                       AND e.status <> 'void' AND e.ts_approved_at IS NULL
                    RETURNING e.id""",
                    (tech_id, client_id, body.period_key))
            except pg_errors.RaiseException as e:
                raise HTTPException(409, e.diag.message_primary or "Entries are period-locked")
            n = len(cur.fetchall())
        auth.audit(conn, "ledger", "Timesheet approved",
                   f"timesheet:{tech_id}|{client_id}|{body.period_key}",
                   f"{n} entries approved via API ({who['label']})")
        return {"approved_entries": n}
