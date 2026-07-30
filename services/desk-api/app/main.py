"""desk-api — Docket's backend, split by concern:
  tickets.py    reads (window.DocketAPI mirror) + create/article/props/tags/merge
  directory.py  groups, agents, clients (+routing domains), contacts, roles read
  projects.py   checklist lifecycle: create → tasks/billing → submit → approve → unlock
Auth: Bearer PAT (auth.py). Invariants live in the DB; routers stay thin."""
from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from . import attachments, automations, db, oidc, sessions, settings, tickets, directory, projects, verification

app = FastAPI(title="desk-api")
app.include_router(sessions.router)
app.include_router(settings.router)
app.include_router(tickets.router)
app.include_router(directory.router)
app.include_router(projects.router)
app.include_router(automations.router)
app.include_router(oidc.router)
app.include_router(verification.router)
app.include_router(attachments.router)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/readyz")
def readyz():
    with db.connect("system") as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM desk.ticket_states")
        (states,) = cur.fetchone()
    return {"ok": True, "ticket_states": states}


@app.get("/")
def root():
    return RedirectResponse("/ui/login.html")

class NoCacheStatic(StaticFiles):
    """UI fixes must land on refresh — never let the browser cache stale JS."""
    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/ui", NoCacheStatic(directory="webui", html=True), name="ui")
