"""Access log (0051, HIPAA review #7) — Ledger's side. Same append-only
audit.access table Docket writes (app='ledger'); time-entry notes can carry
PHI, so page loads, entry reads and client-side exports are recorded here.
Review happens in Docket (Audit Log → Access log, view_audit)."""
from fastapi import APIRouter, Request
from pydantic import BaseModel
from . import auth, db

router = APIRouter()


def client_ip(request: Request) -> str | None:
    return (request.headers.get("x-real-ip")
            or (request.client.host if request.client else None))


def log(conn, request: Request, who: dict, kind: str, detail: str = ""):
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO audit.access
                         (agent_id, app, kind, detail, ip, user_agent)
                       VALUES (%s, 'ledger', %s, %s, %s, %s)""",
                    (who.get("agent_id"), kind, (detail or "")[:2000],
                     client_ip(request),
                     (request.headers.get("user-agent") or "")[:200]))


class ExportReport(BaseModel):
    what: str
    rows: int = 0
    copy: bool = False


@router.post("/api/access/export")
def export_report(body: ExportReport, request: Request):
    """Client-side Ledger exports (CSV download / clipboard copy) report
    here — the only record of that disclosure."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        log(conn, request, who, "export",
            f"{'copied' if body.copy else 'downloaded'} {body.what[:200]} · "
            f"{max(0, body.rows)} rows")
        return {"ok": True}
