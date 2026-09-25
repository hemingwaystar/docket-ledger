"""Microsoft 365 contact sync — per-client tenant links (0048).

The sync itself runs in the mail-worker (m365sync.py). This router only lets
an admin link a client to its tenant, find the tenant id from the client's
email domain, ask for a sync now, and receive Microsoft's admin-consent
redirect. App credentials are set in Settings (config/m365_sync + the sealed
'm365_sync' secret). No DELETE: unlinking = disabling (enabled false).
"""
import re
import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from . import auth, db, helpers

router = APIRouter(prefix="/api/m365")

GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DOMAIN = re.compile(r"^[a-z0-9.-]+\.[a-z]{2,}$")


def _tenant_for_domain(domain: str) -> str | None:
    """Public OpenID discovery — no credentials. The issuer names the tenant
    GUID of whichever Entra tenant has the domain verified."""
    if not DOMAIN.match(domain):
        return None
    try:
        resp = httpx.get(f"https://login.microsoftonline.com/{domain}"
                         "/v2.0/.well-known/openid-configuration", timeout=10)
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    m = re.search(r"login\.microsoftonline\.com/([0-9a-f-]{36})/", resp.json().get("issuer", ""))
    return m.group(1) if m else None


@router.post("/clients/{handle}/detect")
def detect_tenant(handle: str, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_clients")
        with conn.cursor() as cur:
            cid = helpers.client_id(cur, handle)
            cur.execute("SELECT domain FROM shared.client_domains WHERE client_id = %s "
                        "ORDER BY domain", (cid,))
            domains = [r[0] for r in cur.fetchall()]
    if not domains:
        raise HTTPException(409, "This client has no email domain — add one first, "
                                 "or paste the tenant ID")
    for d in domains:
        tid = _tenant_for_domain(d.lower().strip())
        if tid:
            return {"tenant_id": tid, "domain": d}
    raise HTTPException(404, f"No Microsoft 365 tenant found for {', '.join(domains)}")


class TenantLink(BaseModel):
    tenant_id: str
    enabled: bool = True


@router.put("/clients/{handle}")
def link_tenant(handle: str, body: TenantLink, request: Request):
    tid = body.tenant_id.strip().lower()
    if not GUID.match(tid):
        raise HTTPException(422, "Tenant ID must be the directory GUID "
                                 "(xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_clients")
        with conn.cursor() as cur:
            cid = helpers.client_id(cur, handle)
            cur.execute("SELECT c.name FROM shared.m365_tenants t "
                        "JOIN shared.clients c ON c.id = t.client_id "
                        "WHERE t.tenant_id = %s AND t.client_id <> %s", (tid, cid))
            other = cur.fetchone()
            if other:
                raise HTTPException(409, f"That tenant is already linked to {other[0]}")
            cur.execute("SELECT tenant_id, enabled FROM shared.m365_tenants "
                        "WHERE client_id = %s", (cid,))
            was = cur.fetchone()
            cur.execute("""INSERT INTO shared.m365_tenants (client_id, tenant_id, enabled)
                           VALUES (%s, %s, %s)
                           ON CONFLICT (client_id) DO UPDATE
                             SET tenant_id = EXCLUDED.tenant_id,
                                 enabled = EXCLUDED.enabled,
                                 -- a new tenant or re-enable syncs on the next pass
                                 sync_requested = shared.m365_tenants.sync_requested
                                   OR shared.m365_tenants.tenant_id <> EXCLUDED.tenant_id
                                   OR (EXCLUDED.enabled AND NOT shared.m365_tenants.enabled),
                                 updated_at = now(),
                                 updated_by = shared.current_actor()""",
                        (cid, tid, body.enabled))
        what = ("linked to tenant " + tid if was is None or was[0] != tid else
                "sync " + ("enabled" if body.enabled else "paused"))
        if was is None or was[0] != tid or was[1] != body.enabled:
            auth.audit(conn, "desk", "Microsoft 365 link updated", f"client:{cid}",
                       f"{handle} · {what} ({who['label']})")
        return {"ok": True}


@router.post("/clients/{handle}/sync")
def sync_now(handle: str, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_clients")
        with conn.cursor() as cur:
            cid = helpers.client_id(cur, handle)
            cur.execute("""UPDATE shared.m365_tenants SET sync_requested = true
                            WHERE client_id = %s AND enabled""", (cid,))
            if not cur.rowcount:
                raise HTTPException(409, "Link this client to its tenant (and enable the "
                                         "sync) first")
        return {"ok": True, "note": "runs within one worker pass (~30 s)"}


@router.get("/consented")
def consented(request: Request, state: str = "", tenant: str = "",
              admin_consent: str = "", error: str = "", error_description: str = ""):
    """Microsoft's admin-consent redirect (register <origin>/api/m365/consented
    on the app). state = the client's id. Success queues a first sync;
    failure is recorded on the client's link so the card shows why."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_clients")
        with conn.cursor() as cur:
            cur.execute("SELECT client_id, tenant_id FROM shared.m365_tenants "
                        "WHERE client_id::text = %s", (state,))
            row = cur.fetchone()
            if row is None:
                return RedirectResponse("/", status_code=303)
            cid, tid = row
            ok = admin_consent.lower() == "true" and not error
            if ok and tenant and tenant.lower() != tid:
                ok, error_description = False, (f"consent was granted in tenant {tenant}, "
                                                f"but this client is linked to {tid}")
            if ok:
                cur.execute("""UPDATE shared.m365_tenants
                                  SET sync_requested = true, last_status = 'Consent granted — first sync queued'
                                WHERE client_id = %s""", (cid,))
            else:
                cur.execute("""UPDATE shared.m365_tenants SET last_status = %s
                                WHERE client_id = %s""",
                            ("FAILED — consent not granted: "
                             + (error_description or error or "cancelled")[:240], cid))
        auth.audit(conn, "desk",
                   "Microsoft 365 consent granted" if ok else "Microsoft 365 consent failed",
                   f"client:{cid}", f"tenant {tid} ({who['label']})"
                   + ("" if ok else f" · {(error_description or error or 'cancelled')[:200]}"))
    return RedirectResponse("/", status_code=303)
