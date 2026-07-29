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
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg import errors as pg_errors
from pydantic import BaseModel
from . import auth, db

app = FastAPI(title="ledger-api")


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/readyz")
def readyz():
    with db.connect("system") as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM ledger.activity_types")
        (types,) = cur.fetchone()
    return {"ok": True, "activity_types": types}


@app.get("/me")
def me(request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        return {"name": who["name"], "email": who["email"],
                "perms": sorted(who["perms"])}


@app.get("/api/bootstrap")
def bootstrap(request: Request, limit: int = 1000):
    """Ledger prototype-shaped state: directory, entries, periods, projects."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        ms = lambda dt: int(dt.timestamp() * 1000) if dt else None
        out = {"me": {"name": who["name"], "email": who["email"],
                      "initials": "".join(w[0] for w in who["name"].split()[:2]).upper(),
                      "perms": sorted(who["perms"])}}
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""SELECT c.id, c.name, c.is_sentinel, c.billing_cycle,
                                  c.billable_default, c.archived_at,
                                  (SELECT cr.rate_cents FROM ledger.client_rates cr
                                    WHERE cr.client_id = c.id AND cr.activity_type_id IS NULL
                                    ORDER BY cr.valid_from DESC LIMIT 1) AS wide_rate
                             FROM shared.clients c ORDER BY c.is_sentinel DESC, c.name""")
            clients = {str(r["id"]): {"id": str(r["id"]), "name": r["name"],
                       "sentinel": r["is_sentinel"], "cycle": r["billing_cycle"],
                       "rateOverride": (r["wide_rate"] / 100) if r["wide_rate"] is not None else None,
                       "billableDefault": r["billable_default"],
                       "archived": r["archived_at"] is not None,
                       "rates": {}, "access": {"mode": "all", "techs": []}}
                       for r in cur.fetchall()}
            cur.execute("""SELECT DISTINCT ON (client_id, activity_type_id)
                                  client_id, activity_type_id, rate_cents, billable
                             FROM ledger.client_rates WHERE activity_type_id IS NOT NULL
                            ORDER BY client_id, activity_type_id, valid_from DESC""")
            for r in cur.fetchall():
                c = clients.get(str(r["client_id"]))
                if c is not None:
                    c["rates"][str(r["activity_type_id"])] = {
                        "rate": (r["rate_cents"] / 100) if r["rate_cents"] is not None else None,
                        "billable": r["billable"]}
            out["clients"] = list(clients.values())
            cur.execute("SELECT id, name, initials, email FROM shared.agents WHERE active ORDER BY name")
            out["techs"] = [{"id": str(r["id"]), "name": r["name"], "initials": r["initials"],
                             "email": r["email"], "groups": []} for r in cur.fetchall()]
            cur.execute("""SELECT t.id, t.name, t.billable, t.is_sentinel,
                                  (SELECT tr.rate_cents FROM ledger.activity_type_rates tr
                                    WHERE tr.activity_type_id = t.id
                                    ORDER BY tr.valid_from DESC LIMIT 1) AS rate
                             FROM ledger.activity_types t WHERE t.active
                            ORDER BY t.is_sentinel, t.name""")
            out["types"] = [{"id": str(r["id"]), "name": r["name"], "billable": r["billable"],
                             "sentinel": r["is_sentinel"], "active": True, "note": "",
                             "rate": (r["rate"] / 100) if r["rate"] is not None else 0}
                            for r in cur.fetchall()]
            cur.execute("""SELECT bp.id, bp.client_id, bp.period_key, bp.status,
                                  bp.export_ref, bp.approved_at, bp.exported_at,
                                  ag.name AS approved_by_name
                             FROM ledger.billing_periods bp
                             LEFT JOIN shared.agents ag ON ag.id = bp.approved_by
                            ORDER BY bp.period_key""")
            out["periods"] = [{"id": str(r["id"]), "clientId": str(r["client_id"]),
                               "key": r["period_key"], "status": r["status"],
                               "exportRef": r["export_ref"],
                               "approvedAt": ms(r["approved_at"]),
                               "approvedBy": r["approved_by_name"],
                               "exportedAt": ms(r["exported_at"])} for r in cur.fetchall()]
            cur.execute("""SELECT e.id, e.ticket_id, e.task_id, e.client_id, e.tech_id,
                                  e.activity_type_id, e.article_id, e.started_at, e.ended_at, e.hours,
                                  COALESCE(NULLIF(e.note, ''),
                                           left(ar.body, 140), '') AS note,
                                  e.status, e.void_reason, e.voided_at,
                                  e.submitted_at, e.ts_approved_at, e.ts_approved_by,
                                  e.returned_at, e.returned_by, e.return_reason,
                                  e.created_at,
                                  tk.title AS ticket_title,
                                  pt.label AS task_label,
                                  ap.name AS approver_name,
                                  rb.name AS returner_name
                             FROM ledger.time_entries e
                             LEFT JOIN desk.tickets tk ON tk.id = e.ticket_id
                             LEFT JOIN desk.project_tasks pt ON pt.id = e.task_id
                             LEFT JOIN desk.articles ar ON ar.id = e.article_id
                             LEFT JOIN shared.agents ap ON ap.id = e.ts_approved_by
                             LEFT JOIN shared.agents rb ON rb.id = e.returned_by
                            ORDER BY e.started_at DESC LIMIT %s""", (limit,))
            out["entries"] = [{
                "id": str(r["id"]), "zEntryId": str(r["id"])[:8],
                "zArticleId": str(r["article_id"])[:8] if r["article_id"] else None,
                "zTicket": r["ticket_id"], "ticketTitle": r["ticket_title"] or "",
                "clientId": str(r["client_id"]), "techId": str(r["tech_id"]),
                "typeId": str(r["activity_type_id"]), "content": r["note"] or "",
                "startedAt": ms(r["started_at"]), "endedAt": ms(r["ended_at"]),
                "hours": float(r["hours"]), "status": r["status"],
                "source": "api", "createdAt": ms(r["created_at"]),
                "voidedAt": ms(r["voided_at"]), "voidReason": r["void_reason"],
                "zDeleted": False,
                "submitted": r["submitted_at"] is not None,
                "submittedAt": ms(r["submitted_at"]),
                "tsApproved": r["ts_approved_at"] is not None,
                "tsApprovedAt": ms(r["ts_approved_at"]),
                "tsApprovedBy": r["approver_name"],
                "returnedAt": ms(r["returned_at"]), "returnedBy": r["returner_name"],
                "returnReason": r["return_reason"],
                "zTask": ({"id": str(r["task_id"]), "label": r["task_label"] or ""}
                          if r["task_id"] else None)} for r in cur.fetchall()]
            cur.execute("""SELECT p.ticket_id, p.billing_model, p.project_flat_cents,
                                  p.status, p.approved_at
                             FROM desk.projects p WHERE p.status = 'approved'""")
            out["projects"] = [{"zTicket": r["ticket_id"],
                                "pmode": "flat" if r["billing_model"] == "project_flat" else "tasks",
                                "projectFlat": (r["project_flat_cents"] or 0) / 100 or None,
                                "approvedAt": ms(r["approved_at"])} for r in cur.fetchall()]
        return out


class Classify(BaseModel):
    activity_type: str | None = None
    started_at: str | None = None      # span edits — pre-submission only
    ended_at: str | None = None
    void: bool | None = None           # removed-in-Docket semantics; never delete
    void_reason: str = ""


@app.patch("/api/entries/{entry_id}")
def classify_entry(entry_id: str, body: Classify, request: Request):
    """Entry edits from the Ledger UI: reclassify or adjust the span
    (pre-submission), or void. Approved/period-locked rows: the DB freeze
    guard (SECURITY DEFINER since 0012) refuses and we return 409."""
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
            # span/type edits stop at submission; a void is allowed until
            # manager approval (the freeze guard has the final word regardless)
            gate = ("AND ts_approved_at IS NULL" if body.void
                    else "AND status = 'pending' AND submitted_at IS NULL")
            try:
                cur.execute(f"""UPDATE ledger.time_entries SET {', '.join(sets)}
                                 WHERE id = %s {gate}
                               RETURNING id""", (*args, entry_id))
            except pg_errors.RaiseException as e:
                raise HTTPException(409, e.diag.message_primary or "Entry is immutable")
            if cur.fetchone() is None:
                raise HTTPException(409, "Entry missing, submitted, approved, or immutable")
        auth.audit(conn, "ledger", "Entry updated", f"entry:{entry_id}",
                   " · ".join(notes) + f" ({who['label']})")
        return {"ok": True, "changed": notes}


@app.post("/api/entries/{entry_id}/recall")
def recall_entry(entry_id: str, request: Request):
    """A tech pulls their own submission back for edits — the reverse of
    submit, legal until a manager approves."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'l_submit')
        with conn.cursor() as cur:
            cur.execute("""UPDATE ledger.time_entries
                              SET submitted_at = NULL
                            WHERE id = %s AND submitted_at IS NOT NULL
                              AND ts_approved_at IS NULL AND status = 'pending'
                           RETURNING id""", (entry_id,))
            if cur.fetchone() is None:
                raise HTTPException(409, "Entry missing, not submitted, or already approved")
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


@app.get("/")
def root():
    return RedirectResponse("/ui/index.html")


class NoCacheStatic(StaticFiles):
    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/ui", NoCacheStatic(directory="webui", html=True), name="ui")
