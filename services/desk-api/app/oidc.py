"""Entra ID OIDC sign-in — the second auth path (roadmap step, user-ordered
ahead of nginx). Authorization-code flow, confidential client:

  /auth/oidc/login    → 302 to Entra authorize (state+nonce in a KEK-sealed
                        cookie — no server-side flow table needed)
  /auth/oidc/callback → code exchange with the `entra_oidc` secret →
                        claim validation → agent match → same session as
                        local login (sessions.mint_session)
  /auth/methods       → unauthenticated: which sign-in paths are on, so the
                        login page renders the right controls

Config: app_config('auth') — sso_enabled, tenant, client_id, redirect_uri,
role_mapping (+ the existing local_passwords / mfa). tenant and client_id
fall back to the Graph app registration ('graph' config): the intended
setup is ONE Entra app for ingestion, verification sends, AND sign-in —
add a Web redirect URI and the `entra_oidc` client secret to it.

ID-token validation: aud, exp, nonce, and (when the configured tenant is a
GUID) tid. The token arrives on the client-authenticated, TLS-verified
back-channel straight from the token endpoint, where OIDC Core §3.1.3.7
permits TLS server validation in place of signature checking — so no JWKS
dependency. Entra note: redirect URIs must be HTTPS (http://localhost is the
only exception) — test pre-nginx via an SSH port-forward with a
http://localhost:8081/auth/oidc/callback URI registered; add the real
https:// URI at nginx go-live.

Role mapping (when ON): the token's `groups` claim (object IDs by default,
or names if the app registration emits them) is matched against
shared.roles.entra_group; on multiple matches the role granting the most
permissions wins; no match leaves the role untouched. MFA for SSO sign-ins
is Entra's job — the local TOTP policy applies to local passwords only.
"""
import base64
import json
import secrets as pysecrets
import time
import urllib.parse

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse

from . import auth, crypto, db, sessions

router = APIRouter(prefix="/auth")

FLOW_COOKIE = "hts_oidc"
FLOW_TTL = 600                      # seconds to complete the Entra round-trip


def _cfg(cur) -> dict:
    cur.execute("""SELECT key, value FROM shared.app_config
                    WHERE key IN ('auth', 'graph')""")
    rows = {k: (v if isinstance(v, dict) else json.loads(v or "{}"))
            for k, v in cur.fetchall()}
    a, g = rows.get("auth", {}), rows.get("graph", {})
    return {"sso_enabled": bool(a.get("sso_enabled")),
            "local_passwords": bool(a.get("local_passwords", True)),
            "role_mapping": bool(a.get("role_mapping")),
            "tenant": a.get("tenant") or g.get("tenant") or "",
            "client_id": a.get("client_id") or g.get("client_id") or "",
            "redirect_uri": a.get("redirect_uri") or ""}


def _redirect_uri(cfg, request: Request) -> str:
    if cfg["redirect_uri"]:
        return cfg["redirect_uri"]
    # derive from the request — works for the localhost port-forward test path
    base = str(request.base_url).rstrip("/")
    return f"{base}/auth/oidc/callback"


def _login_err(msg: str) -> RedirectResponse:
    return RedirectResponse("/ui/login.html?err=" + urllib.parse.quote(msg),
                            status_code=302)


def _b64url_json(seg: str) -> dict:
    pad = "=" * (-len(seg) % 4)
    return json.loads(base64.urlsafe_b64decode(seg + pad))


@router.get("/methods")
def methods():
    """Unauthenticated by design — the login page needs it before sign-in.
    Reveals only which doors exist, nothing about who can open them."""
    with db.connect("auth") as conn:
        with conn.cursor() as cur:
            c = _cfg(cur)
    return {"sso": c["sso_enabled"] and bool(c["tenant"] and c["client_id"]),
            "local": c["local_passwords"]}


@router.get("/oidc/login")
def oidc_login(request: Request):
    with db.connect("auth") as conn:
        with conn.cursor() as cur:
            c = _cfg(cur)
    if not (c["sso_enabled"] and c["tenant"] and c["client_id"]):
        return _login_err("SSO is not enabled — sign in with a password")
    state = pysecrets.token_urlsafe(24)
    nonce = pysecrets.token_urlsafe(24)
    sealed = base64.urlsafe_b64encode(crypto.seal(json.dumps(
        {"s": state, "n": nonce, "x": int(time.time()) + FLOW_TTL}).encode())).decode()
    q = urllib.parse.urlencode({
        "client_id": c["client_id"], "response_type": "code",
        "redirect_uri": _redirect_uri(c, request), "response_mode": "query",
        "scope": "openid profile email", "state": state, "nonce": nonce})
    resp = RedirectResponse(
        f"https://login.microsoftonline.com/{c['tenant']}/oauth2/v2.0/authorize?{q}",
        status_code=302)
    resp.set_cookie(FLOW_COOKIE, sealed, httponly=True, samesite="lax",
                    secure=False, max_age=FLOW_TTL, path="/auth/oidc")
    return resp


@router.get("/oidc/callback")
def oidc_callback(request: Request, code: str | None = None,
                  state: str | None = None, error: str | None = None,
                  error_description: str | None = None):
    if error:
        return _login_err(f"Microsoft declined the sign-in: "
                          f"{(error_description or error)[:180]}")
    if not code or not state:
        return _login_err("Sign-in response was incomplete — try again")
    # flow cookie: proves this callback belongs to a login WE started
    sealed = request.cookies.get(FLOW_COOKIE)
    if not sealed:
        return _login_err("Sign-in flow expired — try again")
    try:
        flow = json.loads(crypto.open_(
            base64.urlsafe_b64decode(sealed.encode())).decode())
    except Exception:
        return _login_err("Sign-in flow could not be verified — try again")
    if flow.get("s") != state or int(flow.get("x", 0)) < time.time():
        return _login_err("Sign-in flow expired — try again")

    with db.connect("auth") as conn:
        with conn.cursor() as cur:
            c = _cfg(cur)
            if not c["sso_enabled"]:
                return _login_err("SSO is not enabled")
            cur.execute("SELECT ciphertext FROM shared.secrets WHERE name = 'entra_oidc'")
            row = cur.fetchone()
            if row is None:
                return _login_err("SSO is not fully configured — the OIDC "
                                  "client secret has not been stored")
            secret = crypto.open_(row[0]).decode()
            redirect_uri = _redirect_uri(c, request)
            try:
                resp = httpx.post(
                    f"https://login.microsoftonline.com/{c['tenant']}/oauth2/v2.0/token",
                    data={"grant_type": "authorization_code", "code": code,
                          "client_id": c["client_id"], "client_secret": secret,
                          "redirect_uri": redirect_uri,
                          "scope": "openid profile email"}, timeout=20)
            except httpx.HTTPError as exc:
                return _login_err(f"Could not reach Microsoft: {str(exc)[:120]}")
            if resp.status_code != 200:
                detail = resp.json().get("error_description", resp.text)[:180]
                auth.audit(conn, "auth", "SSO sign-in failed", None,
                           f"token exchange refused: {detail}")
                return _login_err(f"Token exchange failed: {detail}")
            id_token = resp.json().get("id_token", "")
            try:
                claims = _b64url_json(id_token.split(".")[1])
            except Exception:
                return _login_err("Microsoft returned an unreadable token")

            # claim validation (back-channel token — see module docstring)
            if claims.get("aud") != c["client_id"]:
                return _login_err("Token audience mismatch")
            if int(claims.get("exp", 0)) < time.time():
                return _login_err("Token already expired — clock trouble?")
            if claims.get("nonce") != flow.get("n"):
                return _login_err("Sign-in flow could not be verified — try again")
            tenant = c["tenant"].lower()
            if len(tenant) == 36 and tenant.count("-") == 4 \
                    and claims.get("tid", "").lower() != tenant:
                return _login_err("Token tenant mismatch")

            oid = claims.get("oid", "")
            email = (claims.get("preferred_username") or claims.get("email")
                     or claims.get("upn") or "").strip()
            cur.execute("""SELECT id, name, email, entra_object_id FROM shared.agents
                            WHERE active AND (entra_object_id = %s
                                              OR lower(email) = lower(%s))
                            ORDER BY (entra_object_id = %s) DESC LIMIT 1""",
                        (oid, email, oid))
            row = cur.fetchone()
            if row is None:
                auth.audit(conn, "auth", "SSO sign-in refused", None,
                           f"{email or oid} — no matching active agent")
                return _login_err(f"No active agent matches {email or 'this account'}"
                                  " — an admin needs to add you in the Directory")
            agent_id, name, agent_email, known_oid = row
            if oid and not known_oid:
                cur.execute("UPDATE shared.agents SET entra_object_id = %s WHERE id = %s",
                            (oid, agent_id))

            mapped = ""
            if c["role_mapping"]:
                groups = claims.get("groups") or []
                if isinstance(groups, list) and groups:
                    gl = {str(g).lower() for g in groups}
                    cur.execute("""SELECT r.id, r.name,
                                     (SELECT count(*) FROM shared.role_permissions rp
                                       WHERE rp.role_id = r.id) AS nperms
                                     FROM shared.roles r
                                    WHERE r.active AND r.entra_group IS NOT NULL
                                      AND lower(r.entra_group) = ANY(%s)
                                    ORDER BY nperms DESC, r.name LIMIT 1""",
                                (list(gl),))
                    m = cur.fetchone()
                    if m:
                        cur.execute("""UPDATE shared.agents SET role_id = %s
                                        WHERE id = %s AND role_id IS DISTINCT FROM %s""",
                                    (m[0], agent_id, m[0]))
                        if cur.rowcount:
                            mapped = f" · role → {m[1]} (Entra mapping)"

            token, perms = sessions.mint_session(conn, cur, request, agent_id)
        auth.audit(conn, "auth", "Signed in (SSO)", f"agent:{agent_id}",
                   f"{agent_email} via Entra OIDC{mapped}")

    out = RedirectResponse("/ui/index.html", status_code=302)
    # secure=False until the host nginx TLS front is live — flip with sessions.py
    out.set_cookie(sessions.COOKIE, token, httponly=True, samesite="lax",
                   secure=False, max_age=sessions.SESSION_HOURS * 3600, path="/")
    out.delete_cookie(FLOW_COOKIE, path="/auth/oidc")
    return out
