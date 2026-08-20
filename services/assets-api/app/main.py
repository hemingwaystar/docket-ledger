"""assets-api — the Assets (ITAM) backend, split by concern:
  bootstrap.py   GET /api/bootstrap — the whole UI state, one round trip
  items.py       asset CI lifecycle: create / patch (version-locked)
  licenses.py    software & licence pools: create / patch
  contracts.py   vendor contracts & warranties + covered-asset membership
  admin.py       PUT /api/config/assets — the lapse-scan settings
Sessions are desk-api's (shared.sessions, read-only here — the ledger
precedent); every write is need()-gated on the a_* catalog and dual-audited
(assets.asset_events + audit.events app='assets')."""
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from . import admin, auth, bootstrap, contracts, db, items, licenses

app = FastAPI(title="assets-api")
app.include_router(bootstrap.router)
app.include_router(items.router)
app.include_router(licenses.router)
app.include_router(contracts.router)
app.include_router(admin.router)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/readyz")
def readyz():
    with db.connect("system") as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM assets.assets")
        (n,) = cur.fetchone()
    return {"ok": True, "assets": n}


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
    # RELATIVE on purpose: behind nginx the browser sits at /assets/, so an
    # absolute /ui/... would resolve into Docket's namespace and 404
    return RedirectResponse("ui/assets.html")


class NoCacheStatic(StaticFiles):
    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/ui", NoCacheStatic(directory="webui", html=True), name="ui")
