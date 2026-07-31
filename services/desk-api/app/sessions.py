"""Login sessions + local credential management — HANDOFF §10.16 verbatim:
argon2id passwords, TOTP MFA, temp-password must-change flow, NO email reset
links ever — admin-direct resets only, everything audited. Sessions are
DB-backed (0004) with the role matrix snapshotted at sign-in.

Also owns per-user UI prefs (build 10): PUT /auth/me/prefs stores the whole
prefs object under app_config 'uprefs:<agent uuid>' — the uuid comes from
the session, never the body, so nobody can write another user's prefs."""
import hashlib
import json
import os
import secrets as pysecrets
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from . import auth, crypto, db, helpers, totp

router = APIRouter(prefix="/auth")
ph = PasswordHasher()          # argon2id defaults
SESSION_HOURS = 12
COOKIE = "hts_session"
# False until the nginx TLS front is verified, then COOKIE_SECURE=true in
# .env → compose passes it through → restart desk-api. After the flip,
# sign-in works only over https (direct NetBird :8081 logins stop — by design).
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "").lower() in ("1", "true", "yes")


def _mfa_policy(cur) -> str:
    cur.execute("SELECT value FROM shared.app_config WHERE key = 'auth'")
    row = cur.fetchone()
    cfg = row[0] if row else {}
    if isinstance(cfg, str):
        cfg = json.loads(cfg)
    return cfg.get("mfa", "optional")


def _perms_for(cur, agent_id) -> list[str]:
    cur.execute("""SELECT rp.permission_id
                     FROM shared.agents a
                     JOIN shared.role_permissions rp ON rp.role_id = a.role_id
                    WHERE a.id = %s ORDER BY 1""", (agent_id,))
    return [r[0] for r in cur.fetchall()]


def mint_session(conn, cur, request, agent_id) -> tuple[str, list[str]]:
    """One session contract for every sign-in path (local + OIDC): perms
    snapshotted, token hashed at rest, stale rows swept."""
    perms = _perms_for(cur, agent_id)
    token = pysecrets.token_urlsafe(32)
    cur.execute("""INSERT INTO shared.sessions
                     (token_hash, agent_id, perms, expires_at, ip, user_agent)
                   VALUES (%s, %s, %s, now() + make_interval(hours => %s), %s, %s)""",
                (hashlib.sha256(token.encode()).hexdigest(), agent_id, perms,
                 SESSION_HOURS, request.client.host if request.client else None,
                 request.headers.get("user-agent", "")[:200]))
    cur.execute("""DELETE FROM shared.sessions
                    WHERE expires_at < now() - interval '30 days'""")
    return token, perms


class Login(BaseModel):
    email: str
    password: str
    totp_code: str | None = None


@router.post("/login")
def login(body: Login, request: Request, response: Response):
    with db.connect("auth") as conn:
        with conn.cursor() as cur:
            cur.execute("""SELECT id, name, password_hash, password_must_change,
                                  totp_secret_enc, active
                             FROM shared.agents WHERE lower(email) = lower(%s)""",
                        (body.email,))
            row = cur.fetchone()
            generic = HTTPException(401, "Invalid email or password")
            if row is None:
                raise generic
            agent_id, name, pw_hash, must_change, totp_enc, active = row
            if not active or not pw_hash:
                raise generic
            try:
                ph.verify(pw_hash, body.password)
            except VerifyMismatchError:
                auth.audit(conn, "auth", "Login failed", f"agent:{agent_id}",
                           f"{body.email} — wrong password")
                raise generic
            policy = _mfa_policy(cur)
            if totp_enc is not None:
                if not body.totp_code:
                    raise HTTPException(401, "TOTP code required", headers={"X-MFA": "required"})
                secret = crypto.open_(totp_enc).decode()
                if not totp.verify(secret, body.totp_code):
                    auth.audit(conn, "auth", "Login failed", f"agent:{agent_id}",
                               f"{body.email} — bad TOTP")
                    raise HTTPException(401, "Invalid TOTP code")
            elif policy == "required":
                raise HTTPException(403, "MFA is required — enroll first",
                                    headers={"X-MFA": "enroll"})
            token, perms = mint_session(conn, cur, request, agent_id)
        auth.audit(conn, "auth", "Signed in", f"agent:{agent_id}", body.email)
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax",
                        secure=COOKIE_SECURE, max_age=SESSION_HOURS * 3600, path="/")
    return {"name": name, "email": body.email, "perms": perms,
            "must_change_password": must_change}


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        with db.connect("auth") as conn, conn.cursor() as cur:
            cur.execute("UPDATE shared.sessions SET revoked_at = now() WHERE token_hash = %s",
                        (hashlib.sha256(token.encode()).hexdigest(),))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        return {"name": who["name"], "email": who["email"],
                "perms": sorted(who["perms"]),
                "must_change_password": who["must_change"]}


PREFS_CAP = 16 * 1024                  # bytes of serialized JSON — sanity, not quota


@router.put("/me/prefs")
def put_prefs(body: dict, request: Request):
    """The whole prefs object, upserted as one value (read back via bootstrap
    me.prefs). Session-only: the key is derived from the session's agent."""
    raw = json.dumps(body)
    if len(raw.encode()) > PREFS_CAP:
        raise HTTPException(413, "Prefs object exceeds the 16 KB cap")
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO shared.app_config (key, value)
                           VALUES (%s, %s)
                           ON CONFLICT (key) DO UPDATE
                             SET value = EXCLUDED.value, updated_at = now(),
                                 updated_by = shared.current_actor(),
                                 version = shared.app_config.version + 1""",
                        (f"uprefs:{who['agent_id']}", raw))
        return {"ok": True, "prefs": body}


class ChangePassword(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
def change_password(body: ChangePassword, request: Request):
    if len(body.new_password) < 12:
        raise HTTPException(422, "New password must be at least 12 characters")
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        with conn.cursor() as cur:
            cur.execute("SELECT password_hash FROM shared.agents WHERE id = %s",
                        (who["agent_id"],))
            (pw_hash,) = cur.fetchone()
            try:
                ph.verify(pw_hash, body.current_password)
            except VerifyMismatchError:
                raise HTTPException(401, "Current password is wrong")
            cur.execute("""UPDATE shared.agents
                              SET password_hash = %s, password_must_change = false
                            WHERE id = %s""",
                        (ph.hash(body.new_password), who["agent_id"]))
        auth.audit(conn, "auth", "Password changed", f"agent:{who['agent_id']}",
                   f"{who['email']} — self-service")
        return {"ok": True}


@router.post("/mfa/enroll")
def mfa_enroll(request: Request):
    """Self-enroll TOTP: returns the otpauth URI once. Secret stored envelope-
    encrypted; re-enrolling replaces it."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        secret = totp.new_secret()
        with conn.cursor() as cur:
            cur.execute("""UPDATE shared.agents
                              SET totp_secret_enc = %s, totp_enrolled_at = now()
                            WHERE id = %s""",
                        (crypto.seal(secret.encode()), who["agent_id"]))
        auth.audit(conn, "auth", "MFA enrolled", f"agent:{who['agent_id']}", who["email"])
        return {"otpauth_uri": totp.otpauth_uri(secret, who["email"]),
                "secret": secret}


class AdminTarget(BaseModel):
    email: str


@router.post("/admin/set-password")
def admin_set_password(body: AdminTarget, request: Request):
    """Admin-direct reset (§10.16): a one-time temp password shown ONCE to the
    admin here — never emailed — with must-change set."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_roles")
        with conn.cursor() as cur:
            aid, name = helpers.agent(cur, body.email)
            temp = pysecrets.token_urlsafe(12)
            cur.execute("""UPDATE shared.agents
                              SET password_hash = %s, password_must_change = true
                            WHERE id = %s""", (ph.hash(temp), aid))
            cur.execute("""UPDATE shared.sessions SET revoked_at = now()
                            WHERE agent_id = %s AND revoked_at IS NULL""", (aid,))
        auth.audit(conn, "auth", "Password reset (admin)", f"agent:{aid}",
                   f"{name} — temp password issued in-app, must change, NO email sent "
                   f"— by {who['actor']}")
        return {"temp_password": temp, "note": "Shown once. Sessions revoked."}


@router.post("/admin/reset-mfa")
def admin_reset_mfa(body: AdminTarget, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_roles")
        with conn.cursor() as cur:
            aid, name = helpers.agent(cur, body.email)
            cur.execute("""UPDATE shared.agents
                              SET totp_secret_enc = NULL, totp_enrolled_at = NULL
                            WHERE id = %s""", (aid,))
        auth.audit(conn, "auth", "MFA reset (admin)", f"agent:{aid}",
                   f"{name} — TOTP revoked by {who['actor']}")
        return {"ok": True}
