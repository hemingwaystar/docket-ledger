"""Access log (0051, HIPAA review #7) — who READ what. audit.events records
changes; audit.access records reads and disclosures (ticket opens, API reads,
attachment downloads, page loads, exports). Append-only; read back only by
holders of view_audit.

log() is called inline by the read paths (tickets/read.py, attachments.py,
tickets/bootstrap.py); this router adds the two events only the browser can
report — a ticket opened on screen, and a client-side CSV export/copy — plus
the review endpoint."""
from fastapi import APIRouter, Request
from psycopg.rows import dict_row
from pydantic import BaseModel
from . import auth, db, helpers

router = APIRouter(prefix="/api")

KINDS = ("ticket_view", "ticket_read", "ticket_list", "entry_list", "attachment",
         "workspace", "export")


def client_ip(request: Request) -> str | None:
    """The user's address: X-Real-IP from the nginx front, else the socket
    peer (direct overlay-port access has no proxy)."""
    return (request.headers.get("x-real-ip")
            or (request.client.host if request.client else None))


def log(conn, request: Request, who: dict, kind: str, ticket_id=None,
        detail: str = "", app: str = "desk"):
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO audit.access
                         (agent_id, app, kind, ticket_id, detail, ip, user_agent)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (who.get("agent_id"), app, kind, ticket_id, (detail or "")[:2000],
                     client_ip(request),
                     (request.headers.get("user-agent") or "")[:200]))


@router.post("/tickets/{ticket_id}/viewed")
def ticket_viewed(ticket_id: int, request: Request):
    """The UI opened this ticket on screen. Visibility-checked like any read;
    a re-open by the same person within a minute is one view, not two."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        with conn.cursor() as cur:
            helpers.ticket_or_404(cur, ticket_id, who)
            cur.execute("""SELECT 1 FROM audit.access
                            WHERE kind = 'ticket_view' AND ticket_id = %s
                              AND agent_id IS NOT DISTINCT FROM %s
                              AND at > now() - interval '60 seconds' LIMIT 1""",
                        (ticket_id, who.get("agent_id")))
            if cur.fetchone():
                return {"ok": True, "deduped": True}
        log(conn, request, who, "ticket_view", ticket_id, "opened in Docket")
        return {"ok": True}


class ExportReport(BaseModel):
    what: str                  # file name or "Tickets CSV (copy)" etc.
    rows: int = 0
    copy: bool = False
    app: str = "desk"


@router.post("/access/export")
def export_report(body: ExportReport, request: Request):
    """Client-side exports (CSV download / clipboard copy) report here — the
    data never passes the server again, so this is the only record of the
    disclosure. Any signed-in user may report their own export."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        log(conn, request, who, "export", None,
            f"{'copied' if body.copy else 'downloaded'} {body.what[:200]} · "
            f"{max(0, body.rows)} rows",
            app="ledger" if body.app == "ledger" else "desk")
        return {"ok": True}


@router.get("/access")
def list_access(request: Request, ticket: int | None = None, agent: str | None = None,
                kind: str | None = None, app: str | None = None,
                start: str | None = None, end: str | None = None, limit: int = 500):
    """The access log — view_audit only (HIPAA review #6: audit data is for
    audit roles). Filters: ticket id, agent uuid, kind, app, ISO date range."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "view_audit")
        where, args = ["TRUE"], []
        if ticket is not None:
            where.append("x.ticket_id = %s"); args.append(ticket)
        if agent:
            where.append("x.agent_id::text = %s"); args.append(agent)
        if kind in KINDS:
            where.append("x.kind = %s"); args.append(kind)
        if app in ("desk", "ledger"):
            where.append("x.app = %s"); args.append(app)
        if start:
            where.append("x.at >= %s::date"); args.append(start)
        if end:
            where.append("x.at < %s::date + 1"); args.append(end)
        args.append(max(1, min(limit, 5000)))
        ms = lambda dt: int(dt.timestamp() * 1000) if dt else None
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(f"""SELECT x.at, x.app, x.kind, x.ticket_id, x.detail, x.ip,
                                   x.user_agent, x.agent_id,
                                   COALESCE(a.name, x.actor) AS who
                              FROM audit.access x
                              LEFT JOIN shared.agents a ON a.id = x.agent_id
                             WHERE {' AND '.join(where)}
                             ORDER BY x.at DESC LIMIT %s""", args)
            rows = cur.fetchall()
        return {"access": [{"ts": ms(r["at"]), "app": r["app"], "kind": r["kind"],
                            "ticketId": r["ticket_id"], "detail": r["detail"],
                            "ip": r["ip"] or "", "ua": r["user_agent"] or "",
                            "agentId": str(r["agent_id"]) if r["agent_id"] else None,
                            "who": r["who"]} for r in rows]}
