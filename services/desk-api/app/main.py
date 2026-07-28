"""desk-api — Docket's backend. Scaffold: health + version + DB ping.
Endpoints land here next, mirroring the prototype's window.DocketAPI 1:1:
GET /api/tickets, /api/tickets/{id}, /api/reports/queue, /api/audit,
plus the full ticket/project/directory surface."""
from fastapi import FastAPI
from . import db

app = FastAPI(title="desk-api", root_path="/desk")

@app.get("/healthz")
def healthz():
    return {"ok": True}

@app.get("/readyz")
def readyz():
    with db.connect("system") as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM desk.ticket_states")
        (states,) = cur.fetchone()
    return {"ok": True, "ticket_states": states}
