"""ledger-api — Ledger's backend, split by concern:
  bootstrap.py   GET /api/bootstrap — prototype-shaped state, one round trip
  entries.py     entry lifecycle: classify/recall/list/submit
  reports.py     per-tech utilization vs the 75% target
  timesheets.py  (tech, client, period) sheets: return/revoke/approve
  periods.py     period cards, approve & lock, Odoo export pair
  admin.py       config, odoo secret, clients, types, rates, access
Everything prices through the ONE SQL ladder (ledger.priced) so nothing
here can disagree with exports; DB triggers enforce the freeze."""
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from . import admin, auth, bootstrap, db, entries, periods, reports, timesheets

app = FastAPI(title="ledger-api")
app.include_router(bootstrap.router)
app.include_router(entries.router)
app.include_router(reports.router)
app.include_router(timesheets.router)
app.include_router(periods.router)
app.include_router(admin.router)


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


@app.get("/")
def root():
    # RELATIVE on purpose (the assets-api convention): behind nginx the
    # /ledger/ prefix is stripped, so an absolute /ui/… would resolve at the
    # shared origin into DOCKET's namespace and open the wrong app (audit)
    return RedirectResponse("ui/index.html")


class NoCacheStatic(StaticFiles):
    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/ui", NoCacheStatic(directory="webui", html=True), name="ui")
