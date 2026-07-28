"""ledger-api — Ledger's backend.

Read surface mirrors the prototype's window.LedgerAPI, priced by the ONE
SQL pricing ladder (ledger.priced) so nothing here can disagree with exports:
  GET /api/entries?client=&status=    status: pending|submitted|approved|locked|void
  GET /api/reports/utilization        per-tech billable/total/% vs the 75% target
  GET /api/periods?client=            period cards incl. project flat fees

Write paths (timesheet chain — DB triggers enforce the freeze):
  POST /api/entries/{id}/submit
  POST /api/timesheets/approve        {tech_email, client, period_key}
"""
from fastapi import FastAPI, HTTPException, Request
from psycopg.rows import dict_row
from pydantic import BaseModel
from . import auth, db

app = FastAPI(title="ledger-api", root_path="/ledger")


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/readyz")
def readyz():
    with db.connect("system") as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM ledger.activity_types")
        (types,) = cur.fetchone()
    return {"ok": True, "activity_types": types}


ENTRY_SELECT = """
  SELECT e.id, e.ticket_id, e.task_id, c.name AS client, a.name AS technician,
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


@app.get("/api/entries")
def list_entries(request: Request, client: str | None = None, status: str | None = None,
                 limit: int = 200):
    with db.connect() as conn:
        auth.require(conn, request)
        sql, args = ENTRY_SELECT, []
        where = []
        if client:
            where.append("(c.name = %s OR c.id::text = %s)")
            args += [client, client]
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY e.started_at DESC LIMIT %s"
        args.append(min(limit, 1000))
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, args)
            rows = cur.fetchall()
        if status:
            rows = [r for r in rows if r["status"] == status]
        return {"entries": rows}


@app.get("/api/reports/utilization")
def utilization(request: Request, target: float = 0.75):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""
                SELECT a.name AS technician,
                       round(sum(e.hours) FILTER (WHERE p.billable), 2) AS billable_hours,
                       round(sum(e.hours), 2) AS total_hours
                  FROM ledger.time_entries e
                  CROSS JOIN LATERAL ledger.priced(e) AS p
                  JOIN shared.agents a ON a.id = e.tech_id
                 WHERE e.status <> 'void'
                 GROUP BY a.name ORDER BY a.name""")
            rows = cur.fetchall()
        for r in rows:
            bill = float(r["billable_hours"] or 0)
            tot = float(r["total_hours"] or 0)
            r["utilization"] = round(bill / tot, 3) if tot else 0.0
            r["target"] = target
        return {"technicians": rows}


@app.get("/api/periods")
def list_periods(request: Request, client: str | None = None):
    with db.connect() as conn:
        auth.require(conn, request)
        sql = """
          SELECT bp.id, c.name AS client, bp.period_key, bp.status,
                 bp.approved_at, bp.exported_at, bp.export_ref,
                 count(e.id) FILTER (WHERE e.status <> 'void') AS entries,
                 round(COALESCE(sum(e.hours) FILTER (WHERE e.status <> 'void'), 0), 2) AS hours,
                 COALESCE(sum(p.amount_cents) FILTER (WHERE e.status <> 'void'), 0) AS hourly_amount_cents,
                 COALESCE((SELECT sum(fl.amount_cents) FROM ledger.project_flat_lines fl
                            WHERE fl.client_id = bp.client_id
                              AND ledger.period_key_for(bp.client_id, fl.approved_at) = bp.period_key), 0)
                   AS project_flat_cents
            FROM ledger.billing_periods bp
            JOIN shared.clients c ON c.id = bp.client_id
            LEFT JOIN ledger.time_entries e ON e.period_id = bp.id
            LEFT JOIN LATERAL ledger.priced(e) AS p ON TRUE
        """
        args = []
        if client:
            sql += " WHERE (c.name = %s OR c.id::text = %s)"
            args += [client, client]
        sql += " GROUP BY bp.id, c.name ORDER BY bp.period_key DESC, c.name"
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, args)
            return {"periods": cur.fetchall()}


@app.post("/api/entries/{entry_id}/submit")
def submit_entry(entry_id: str, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'l_submit')
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE ledger.time_entries
                   SET submitted_at = now(),
                       returned_at = NULL, returned_by = NULL, return_reason = NULL
                 WHERE id = %s AND status = 'pending' AND submitted_at IS NULL
                   AND activity_type_id <> (SELECT id FROM ledger.activity_types WHERE is_sentinel)
                RETURNING id""", (entry_id,))
            if cur.fetchone() is None:
                raise HTTPException(409, "Entry missing, already submitted, voided, or unclassified")
        auth.audit(conn, "ledger", "Submitted for review", f"entry:{entry_id}", "via API")
        return {"ok": True}


class ReturnSheet(BaseModel):
    tech_email: str
    client: str
    period_key: str
    reason: str = ""


@app.post("/api/timesheets/return")
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
            cur.execute("""
                UPDATE ledger.time_entries e
                   SET submitted_at = NULL,
                       returned_at = now(), return_reason = NULLIF(%s, '')
                  FROM ledger.billing_periods bp
                 WHERE bp.id = e.period_id AND bp.status = 'open'
                   AND e.tech_id = %s AND e.client_id = %s AND bp.period_key = %s
                   AND e.status <> 'void'
                   AND e.submitted_at IS NOT NULL AND e.ts_approved_at IS NULL
                RETURNING e.id""",
                (body.reason, tech_id, client_id, body.period_key))
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


@app.post("/api/timesheets/revoke")
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
            cur.execute("""
                UPDATE ledger.time_entries e
                   SET ts_approved_at = NULL, ts_approved_by = NULL
                  FROM ledger.billing_periods bp
                 WHERE bp.id = e.period_id AND bp.status = 'open'
                   AND e.tech_id = %s AND e.client_id = %s AND bp.period_key = %s
                   AND e.ts_approved_at IS NOT NULL
                RETURNING e.id""", (tech_id, client_id, body.period_key))
            n = len(cur.fetchall())
            if n == 0:
                raise HTTPException(409, "Nothing approved (or the period is locked)")
        auth.audit(conn, "ledger", "Timesheet approval revoked",
                   f"timesheet:{tech_id}|{client_id}|{body.period_key}",
                   f"{n} entries back to Submitted ({who['label']})")
        return {"revoked_entries": n}


class PeriodApprove(BaseModel):
    approver_email: str


@app.post("/api/periods/{period_id}/approve")
def approve_period(period_id: str, body: PeriodApprove, request: Request):
    """Approve & lock a billing period — every entry in it becomes immutable
    (trigger-enforced). Refuses while any live entry is Unclassified. One-way."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'l_approve')
        with conn.cursor() as cur:
            cur.execute("SELECT id, name FROM shared.agents WHERE lower(email) = lower(%s)",
                        (body.approver_email,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, "Unknown approver")
            aid, name = row
            cur.execute("""
                SELECT count(*) FROM ledger.time_entries e
                  JOIN ledger.activity_types at ON at.id = e.activity_type_id
                 WHERE e.period_id = %s AND e.status <> 'void' AND at.is_sentinel""",
                (period_id,))
            (unclassified,) = cur.fetchone()
            if unclassified:
                raise HTTPException(409, f"{unclassified} entries are Unclassified — classify first")
            cur.execute("""
                UPDATE ledger.billing_periods
                   SET status = 'approved', approved_at = now(), approved_by = %s
                 WHERE id = %s AND status = 'open'
                RETURNING client_id, period_key""", (aid, period_id))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(409, "Period missing or not open")
            client_id, period_key = row
        auth.audit(conn, "ledger", "Period approved & locked",
                   f"period:{period_id}", f"{period_key} · approved by {name}")
        return {"ok": True, "period_key": period_key}


def _export_payload(cur, period_id):
    cur.execute("""SELECT bp.client_id, bp.period_key, bp.status, c.name
                     FROM ledger.billing_periods bp
                     JOIN shared.clients c ON c.id = bp.client_id
                    WHERE bp.id = %s""", (period_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(404, "No such period")
    client_id, period_key, status, client_name = row
    if status == "open":
        raise HTTPException(409, "Approve the period before exporting")
    cur.execute("""
        SELECT at.name, p.rate_cents, round(sum(e.hours), 2)
          FROM ledger.time_entries e
          CROSS JOIN LATERAL ledger.priced(e) AS p
          JOIN ledger.activity_types at ON at.id = e.activity_type_id
         WHERE e.period_id = %s AND e.status <> 'void' AND p.billable
         GROUP BY at.name, p.rate_cents ORDER BY at.name""", (period_id,))
    lines = [{"name": n, "quantity": float(q), "price_unit": r / 100.0, "uom": "Hours"}
             for n, r, q in cur.fetchall()]
    cur.execute("""
        SELECT fl.project_title, fl.line_label, fl.amount_cents
          FROM ledger.project_flat_lines fl
         WHERE fl.client_id = %s
           AND ledger.period_key_for(fl.client_id, fl.approved_at) = %s""",
        (client_id, period_key))
    for title, label, cents in cur.fetchall():
        lines.append({"name": f"{title} — {label}", "quantity": 1,
                      "price_unit": cents / 100.0, "uom": "Fee"})
    return {"partner": client_name, "period": period_key,
            "move_type": "out_invoice", "state": "draft",
            "invoice_line_ids": lines,
            "total": round(sum(l["quantity"] * l["price_unit"] for l in lines), 2)}


@app.get("/api/periods/{period_id}/export-payload")
def export_payload(period_id: str, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'l_export')
        with conn.cursor() as cur:
            return _export_payload(cur, period_id)


@app.post("/api/periods/{period_id}/mark-exported")
def mark_exported(period_id: str, request: Request):
    """Stamps the period exported and records the exact payload. The Odoo
    connector posts this payload as a draft invoice once its settings are
    configured; until then this is the open-connector behavior as prototyped."""
    import json
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'l_export')
        with conn.cursor() as cur:
            payload = _export_payload(cur, period_id)
            ref = f"ODO-{payload['period']}-{period_id[:8]}"
            cur.execute("""
                UPDATE ledger.billing_periods
                   SET status = 'exported', exported_at = now(), export_ref = %s
                 WHERE id = %s AND status = 'approved'
                RETURNING id""", (ref, period_id))
            if cur.fetchone() is None:
                raise HTTPException(409, "Period must be approved (and not already exported)")
            cur.execute("""INSERT INTO ledger.odoo_exports (period_id, export_ref, payload)
                           VALUES (%s, %s, %s)""", (period_id, ref, json.dumps(payload)))
        auth.audit(conn, "ledger", "Period exported to Odoo",
                   f"period:{period_id}",
                   f"{payload['period']} · {ref} · total {payload['total']} ({who['label']})")
        return {"export_ref": ref, "payload": payload}


class ApproveSheet(BaseModel):
    tech_email: str
    client: str            # name or uuid
    period_key: str        # '2026-07' / '2026-W31'


@app.post("/api/timesheets/approve")
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
            cur.execute("""
                UPDATE ledger.time_entries e
                   SET ts_approved_at = now()
                  FROM ledger.billing_periods bp
                 WHERE bp.id = e.period_id
                   AND e.tech_id = %s AND e.client_id = %s AND bp.period_key = %s
                   AND e.status <> 'void' AND e.ts_approved_at IS NULL
                RETURNING e.id""",
                (tech_id, client_id, body.period_key))
            n = len(cur.fetchall())
        auth.audit(conn, "ledger", "Timesheet approved",
                   f"timesheet:{tech_id}|{client_id}|{body.period_key}",
                   f"{n} entries approved via API ({who['label']})")
        return {"approved_entries": n}
