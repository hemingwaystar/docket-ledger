"""desk-api — Docket's backend, split by concern:
  tickets.py    reads (window.DocketAPI mirror) + create/article/props/tags/merge
  directory.py  groups, agents, clients (+routing domains), contacts, roles read
  projects.py   checklist lifecycle: create → tasks/billing → submit → approve → unlock
Auth: Bearer PAT (auth.py). Invariants live in the DB; routers stay thin."""
from fastapi import FastAPI
from . import db, tickets, directory, projects

app = FastAPI(title="desk-api", root_path="/desk")
app.include_router(tickets.router)
app.include_router(directory.router)
app.include_router(projects.router)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/readyz")
def readyz():
    with db.connect("system") as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM desk.ticket_states")
        (states,) = cur.fetchone()
    return {"ok": True, "ticket_states": states}
