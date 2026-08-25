"""GET /api/reports/utilization — per-tech billable/total/% vs the 75%
target, priced through ledger.priced like everything else."""
from fastapi import APIRouter, Request
from psycopg.rows import dict_row
from . import auth, db

router = APIRouter()


@router.get("/api/reports/utilization")
def utilization(request: Request, target: float = 0.75):
    with db.connect() as conn:
        who = auth.require(conn, request)
        # every tech's hours ride in this rollup — all-tech read roles only
        auth.need(who, 'l_view_all')
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
