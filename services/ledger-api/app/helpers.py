"""Shared by the ledger routers: the bug-#27 span guard and the Odoo
draft-invoice payload builder (export preview and mark-exported price
from the same function by construction)."""
from fastapi import HTTPException


def _sane_span(started: str | None, ended: str | None):
    """Bug #27 guard: a mistyped year in a datetime-local field created a
    July 1930 entry — and with it a ghost billing period and timesheet.
    Spans must live in the present era."""
    from datetime import datetime, timedelta, timezone
    def parse(v):
        if v is None:
            return None
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(422, f"Unparseable timestamp: {v!r}")
    st, en = parse(started), parse(ended)
    now = datetime.now(timezone.utc)
    for label, dt in (("start", st), ("end", en)):
        if dt is None:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if dt.year < 2020 or dt > now + timedelta(days=400):
            raise HTTPException(422, f"That {label} time ({dt.date()}) is outside the "
                                     "sane window — check the year")


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
    return {"partner": client_name, "client_id": str(client_id), "period": period_key,
            "move_type": "out_invoice", "state": "draft",
            "invoice_line_ids": lines,
            "total": round(sum(l["quantity"] * l["price_unit"] for l in lines), 2)}
