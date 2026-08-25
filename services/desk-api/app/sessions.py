"""Login sessions + local credential management — HANDOFF §10.16 verbatim:
argon2id passwords, TOTP MFA, temp-password must-change flow, NO email reset
links ever — admin-direct resets only, everything audited. Sessions are
DB-backed (0004) with the role matrix snapshotted at sign-in.

TOTP enrollment is two-phase (build 13): /auth/mfa/enroll (session) and
/auth/mfa/enroll-start (pre-session, password-gated — the required-policy
escape hatch) mint a PENDING secret (totp_secret_enc set, totp_enrolled_at
NULL); a valid code at /auth/mfa/confirm — or at /auth/login itself under
required policy — flips it live. The login gate keys on totp_enrolled_at,
so a pending secret never locks anyone out, and an ACTIVE secret is never
replaced here — admin reset (/auth/admin/reset-mfa) is the only path.

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


# brute-force throttle (0040): 5 failures in a 15-minute window lock the key
# for 15 minutes. Keyed per account AND per client address, so guessing burns
# out fast whichever way it fans. The address comes from X-Real-IP when the
# nginx front set it (request.client.host behind the proxy is nginx itself —
# keying on that would lock every user at once); direct overlay-port access
# has no proxy and falls back to the socket peer.
THROTTLE_FAILS = 5
THROTTLE_MINUTES = 15


def _throttle_keys(request, email: str | None = None) -> list[str]:
    keys = []
    if email and email.strip():
        keys.append(f"acct:{email.strip().lower()}"[:200])
    addr = request.headers.get("x-real-ip") or (
        request.client.host if request.client else None)
    if addr:
        keys.append(f"ip:{addr}"[:200])
    return keys


def _throttle_guard(cur, keys):
    if not keys:
        return
    cur.execute("""SELECT 1 FROM shared.auth_throttle
                    WHERE key = ANY(%s) AND locked_until > now() LIMIT 1""", (keys,))
    if cur.fetchone():
        raise HTTPException(429, "Too many failed attempts — try again in a few minutes")


def _throttle_fail(cur, keys):
    """One failed credential check. Rides the caller's failure-audit commit."""
    for k in keys:
        cur.execute("""
            INSERT INTO shared.auth_throttle AS t (key) VALUES (%s)
            ON CONFLICT (key) DO UPDATE SET
              fails = CASE WHEN t.window_start < now() - make_interval(mins => %s)
                           THEN 1 ELSE t.fails + 1 END,
              window_start = CASE WHEN t.window_start < now() - make_interval(mins => %s)
                                  THEN now() ELSE t.window_start END,
              locked_until = CASE WHEN (CASE WHEN t.window_start < now() - make_interval(mins => %s)
                                             THEN 1 ELSE t.fails + 1 END) >= %s
                                  THEN now() + make_interval(mins => %s)
                                  ELSE t.locked_until END""",
                    (k, THROTTLE_MINUTES, THROTTLE_MINUTES, THROTTLE_MINUTES,
                     THROTTLE_FAILS, THROTTLE_MINUTES))


def _throttle_clear(cur, email: str):
    """A successful sign-in clears the ACCOUNT counter only — the address
    counter expires on its own, so interleaved good logins can't feed it."""
    cur.execute("DELETE FROM shared.auth_throttle WHERE key = %s",
                (f"acct:{email.strip().lower()}"[:200],))


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
            tkeys = _throttle_keys(request, body.email)
            _throttle_guard(cur, tkeys)
            cur.execute("""SELECT id, name, password_hash, password_must_change,
                                  totp_secret_enc, totp_enrolled_at, active,
                                  last_totp_step
                             FROM shared.agents WHERE lower(email) = lower(%s)""",
                        (body.email,))
            row = cur.fetchone()
            generic = HTTPException(401, "Invalid email or password")
            if row is None:
                _throttle_fail(cur, tkeys)
                conn.commit()  # keep the counter — the raise would roll it back
                raise generic
            (agent_id, name, pw_hash, must_change, totp_enc, totp_enrolled_at,
             active, last_step) = row
            if not active or not pw_hash:
                _throttle_fail(cur, tkeys)
                conn.commit()  # keep the counter — the raise would roll it back
                raise generic
            try:
                ph.verify(pw_hash, body.password)
            except VerifyMismatchError:
                auth.audit(conn, "auth", "Login failed", f"agent:{agent_id}",
                           f"{body.email} — wrong password")
                _throttle_fail(cur, tkeys)
                conn.commit()  # keep the failure audit — the raise would roll it back
                raise generic
            policy = _mfa_policy(cur)
            # the gate keys on totp_enrolled_at, NOT secret presence — a
            # PENDING secret (enrollment started, code never confirmed)
            # must never lock the account
            enrolled = totp_enrolled_at is not None
            if enrolled:
                if not body.totp_code:
                    raise HTTPException(401, "TOTP code required", headers={"X-MFA": "required"})
                secret = crypto.open_(totp_enc).decode()
                step = totp.verify_step(secret, body.totp_code)
                if step is None:
                    auth.audit(conn, "auth", "Login failed", f"agent:{agent_id}",
                               f"{body.email} — bad TOTP")
                    _throttle_fail(cur, tkeys)
                    conn.commit()  # keep the failure audit — the raise would roll it back
                    raise HTTPException(401, "Invalid TOTP code")
                if last_step is not None and step <= last_step:
                    # a code at/behind the last accepted step is a replay
                    auth.audit(conn, "auth", "Login failed", f"agent:{agent_id}",
                               f"{body.email} — TOTP replay")
                    _throttle_fail(cur, tkeys)
                    conn.commit()  # keep the failure audit — the raise would roll it back
                    raise HTTPException(401, "That code was already used — wait for the next one")
                cur.execute("UPDATE shared.agents SET last_totp_step = %s WHERE id = %s",
                            (step, agent_id))
            elif policy == "required":
                if totp_enc is not None and body.totp_code:
                    # pending secret: proof of possession completes enrollment
                    secret = crypto.open_(totp_enc).decode()
                    step = totp.verify_step(secret, body.totp_code)
                    if step is None:
                        auth.audit(conn, "auth", "Login failed", f"agent:{agent_id}",
                                   f"{body.email} — bad TOTP (enrollment)")
                        _throttle_fail(cur, tkeys)
                        conn.commit()  # keep the failure audit — the raise would roll it back
                        raise HTTPException(401, "Invalid TOTP code")
                    cur.execute("""UPDATE shared.agents
                                      SET totp_enrolled_at = now(), last_totp_step = %s
                                    WHERE id = %s""", (step, agent_id))
                    auth.audit(conn, "auth", "MFA enrolled", f"agent:{agent_id}",
                               f"{body.email} — confirmed at sign-in")
                else:
                    raise HTTPException(403, "MFA is required — enroll below",
                                        headers={"X-MFA": "enroll"})
            # optional policy + pending/no secret → plain password sign-in
            # (a pending secret stays inert until confirmed)
            _throttle_clear(cur, body.email)
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
        who = auth.require(conn, request, allow_must_change=True)
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
        who = auth.require(conn, request, allow_must_change=True)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        with conn.cursor() as cur:
            tkeys = _throttle_keys(request, who["email"])
            _throttle_guard(cur, tkeys)
            cur.execute("SELECT password_hash FROM shared.agents WHERE id = %s",
                        (who["agent_id"],))
            (pw_hash,) = cur.fetchone()
            try:
                ph.verify(pw_hash, body.current_password)
            except VerifyMismatchError:
                _throttle_fail(cur, tkeys)
                conn.commit()  # keep the counter — the raise would roll it back
                raise HTTPException(401, "Current password is wrong")
            cur.execute("""UPDATE shared.agents
                              SET password_hash = %s, password_must_change = false
                            WHERE id = %s""",
                        (ph.hash(body.new_password), who["agent_id"]))
            # every OTHER session dies with the old password — the standard
            # "change my password to lock the intruder out" expectation
            # (admin resets already did this; the self-service path now matches)
            token = request.cookies.get(COOKIE)
            cur.execute("""UPDATE shared.sessions SET revoked_at = now()
                            WHERE agent_id = %s AND revoked_at IS NULL
                              AND token_hash <> %s""",
                        (who["agent_id"],
                         hashlib.sha256((token or "").encode()).hexdigest()))
        auth.audit(conn, "auth", "Password changed", f"agent:{who['agent_id']}",
                   f"{who['email']} — self-service; other sessions revoked")
        return {"ok": True}


@router.post("/mfa/enroll")
def mfa_enroll(request: Request):
    """Self-enroll TOTP, phase one: mints a PENDING secret (enrolled_at NULL,
    envelope-encrypted at rest) and returns the otpauth URI once. Nothing is
    live until a valid code lands at /auth/mfa/confirm — or at /auth/login
    under required policy. Refuses to replace an ACTIVE secret: admin reset
    is the only path (a hijacked session must not silently swap MFA)."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        with conn.cursor() as cur:
            cur.execute("SELECT totp_enrolled_at FROM shared.agents WHERE id = %s",
                        (who["agent_id"],))
            (enrolled_at,) = cur.fetchone()
            if enrolled_at is not None:
                raise HTTPException(409, "MFA is already enrolled — an admin must reset it first")
            secret = totp.new_secret()
            cur.execute("""UPDATE shared.agents
                              SET totp_secret_enc = %s, totp_enrolled_at = NULL
                            WHERE id = %s""",
                        (crypto.seal(secret.encode()), who["agent_id"]))
        auth.audit(conn, "auth", "MFA enrollment started", f"agent:{who['agent_id']}",
                   f"{who['email']} — pending code confirmation")
        return {"otpauth_uri": totp.otpauth_uri(secret, who["email"]),
                "secret": secret}


class MfaConfirm(BaseModel):
    code: str


@router.post("/mfa/confirm")
def mfa_confirm(body: MfaConfirm, request: Request):
    """Prove possession: a valid code flips the pending secret live."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        with conn.cursor() as cur:
            cur.execute("""SELECT totp_secret_enc, totp_enrolled_at
                             FROM shared.agents WHERE id = %s""", (who["agent_id"],))
            enc, at = cur.fetchone()
            if enc is None:
                raise HTTPException(409, "No enrollment in progress — start one first")
            if at is not None:
                return {"ok": True}                     # already live — idempotent
            tkeys = _throttle_keys(request, who["email"])
            _throttle_guard(cur, tkeys)
            step = totp.verify_step(crypto.open_(enc).decode(), body.code)
            if step is None:
                _throttle_fail(cur, tkeys)
                conn.commit()  # keep the counter — the raise would roll it back
                raise HTTPException(401, "Invalid TOTP code")
            cur.execute("""UPDATE shared.agents
                              SET totp_enrolled_at = now(), last_totp_step = %s
                            WHERE id = %s""", (step, who["agent_id"]))
        auth.audit(conn, "auth", "MFA enrolled", f"agent:{who['agent_id']}", who["email"])
        return {"ok": True}


class EnrollStart(BaseModel):
    email: str
    password: str


@router.post("/mfa/enroll-start")
def mfa_enroll_start(body: EnrollStart, request: Request):
    """Login-time enrollment: password re-verified, no session needed. Mints a
    PENDING secret (active only after a valid code at /auth/login). Refuses if
    MFA is already live — admin reset is the only way to replace an active secret."""
    with db.connect("auth") as conn, conn.cursor() as cur:
        tkeys = _throttle_keys(request, body.email)
        _throttle_guard(cur, tkeys)
        cur.execute("""SELECT id, password_hash, totp_enrolled_at, active
                         FROM shared.agents WHERE lower(email) = lower(%s)""",
                    (body.email,))
        row = cur.fetchone()
        generic = HTTPException(401, "Invalid email or password")
        if row is None:
            _throttle_fail(cur, tkeys)
            conn.commit()  # keep the counter — the raise would roll it back
            raise generic
        agent_id, pw_hash, enrolled_at, active = row
        if not active or not pw_hash:
            _throttle_fail(cur, tkeys)
            conn.commit()  # keep the counter — the raise would roll it back
            raise generic
        try:
            ph.verify(pw_hash, body.password)
        except VerifyMismatchError:
            auth.audit(conn, "auth", "MFA enroll-start failed", f"agent:{agent_id}",
                       f"{body.email} — wrong password")
            _throttle_fail(cur, tkeys)
            conn.commit()  # keep the failure audit — the raise would roll it back
            raise generic
        if enrolled_at is not None:
            raise HTTPException(409, "MFA is already enrolled — ask an admin to reset it")
        secret = totp.new_secret()
        cur.execute("""UPDATE shared.agents SET totp_secret_enc = %s, totp_enrolled_at = NULL
                        WHERE id = %s""", (crypto.seal(secret.encode()), agent_id))
        auth.audit(conn, "auth", "MFA enrollment started", f"agent:{agent_id}",
                   f"{body.email} — at sign-in, pending code confirmation")
        return {"otpauth_uri": totp.otpauth_uri(secret, body.email.lower()),
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
