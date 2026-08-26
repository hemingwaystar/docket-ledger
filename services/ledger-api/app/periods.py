"""Billing periods — the cards and the one-way export chain:
  GET /api/periods?client=                period cards incl. project flat fees
  POST /api/periods/{id}/approve          approve & lock; entries go immutable
  GET /api/periods/{id}/export-payload    Odoo draft-invoice preview
  POST /api/periods/{id}/mark-exported    stamp + record the exact payload"""
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from pydantic import BaseModel
from . import auth, db
from .helpers import _export_payload

router = APIRouter()


@router.get("/api/periods")
def list_periods(request: Request, client: str | None = None):
    with db.connect() as conn:
        who = auth.require(conn, request)
        # period cards carry billed totals — money-side roles only (audit)
        auth.need(who, 'l_approve', 'l_export', 'l_see_amounts')
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
            rows = cur.fetchall()
        # billed dollars ship only with l_see_amounts (same rule everywhere);
        # approve/export roles without it still see hours and entry counts
        if who["kind"] == "session" and "l_see_amounts" not in who["perms"]:
            for r in rows:
                r["hourly_amount_cents"] = None
                r["project_flat_cents"] = None
        return {"periods": rows}


class PeriodApprove(BaseModel):
    approver_email: str


@router.post("/api/periods/{period_id}/approve")
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
            # lock the period row FIRST: the 0039 insert guard takes FOR
            # SHARE on it, so any in-flight time INSERT commits (and is
            # counted below) or waits behind this approval — an unclassified
            # entry can no longer slip in between the count and the flip
            cur.execute("SELECT status FROM ledger.billing_periods WHERE id = %s FOR UPDATE",
                        (period_id,))
            prow = cur.fetchone()
            if prow is None or prow[0] != "open":
                raise HTTPException(409, "Period missing or not open")
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


@router.get("/api/periods/{period_id}/export-payload")
def export_payload(period_id: str, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'l_export')
        with conn.cursor() as cur:
            return _export_payload(cur, period_id)


@router.post("/api/periods/{period_id}/mark-exported")
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
