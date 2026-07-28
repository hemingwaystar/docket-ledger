"""ledger-api — Ledger's backend. Scaffold: health + version + DB ping.
Endpoints land here next, mirroring the prototype's window.LedgerAPI 1:1:
GET /api/tickets, /api/tickets/{id}, /api/reports/queue, /api/audit,
plus the full ticket/project/directory surface."""
from fastapi import FastAPI
from . import db

app = FastAPI(title="desk-api", root_path="/ledger")

@app.get("/healthz")
def healthz():
    return {"ok": True}

@app.get("/readyz")
def readyz():
    with db.connect("system") as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM ledger.activity_types")
        (states,) = cur.fetchone()
    return {"ok": True, "activity_types": states}
