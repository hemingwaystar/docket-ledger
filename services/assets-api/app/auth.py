"""Authentication for every request: a login session cookie (browsers) or a
Bearer PAT (integrations/scripts). Sessions enforce RBAC via need(); PATs are
trusted service credentials (all-scope) — §10.17. Sets app.actor for the
audit triggers either way.

HIPAA review (0049): permissions are read LIVE from the agent's current role
on every request — a demotion or a role edit applies immediately, not at the
next sign-in. And sessions log off automatically after app_config
auth.idle_minutes (default 15, clamped 5..480) without user activity; a
request carrying X-HTS-Passive: 1 (background polls) never counts as
activity. This file is identical in desk-api, ledger-api and assets-api."""
import hashlib
from fastapi import HTTPException, Request

COOKIE = "hts_session"
PASSIVE_HEADER = "x-hts-passive"


def require(conn, request: Request, allow_must_change: bool = False) -> dict:
    token = request.cookies.get(COOKIE)
    if token:
        digest = hashlib.sha256(token.encode()).hexdigest()
        with conn.cursor() as cur:
            cur.execute("""
                SELECT s.id, s.agent_id, a.name, a.email, a.password_must_change,
                       COALESCE(ARRAY(SELECT rp.permission_id
                                        FROM shared.role_permissions rp
                                       WHERE rp.role_id = a.role_id ORDER BY 1),
                                '{}') AS perms,
                       COALESCE(s.last_seen_at, s.created_at)
                         < now() - make_interval(mins => i.mins) AS idle,
                       i.mins
                  FROM shared.sessions s
                  JOIN shared.agents a ON a.id = s.agent_id
                 CROSS JOIN LATERAL (
                       SELECT GREATEST(5, LEAST(480, COALESCE(
                                (SELECT (c.value->>'idle_minutes')::int
                                   FROM shared.app_config c
                                  WHERE c.key = 'auth'
                                    AND c.value->>'idle_minutes' ~ '^[0-9]{1,4}$'),
                                15))) AS mins) i
                 WHERE s.token_hash = %s AND s.revoked_at IS NULL
                   AND s.expires_at > now() AND a.active""", (digest,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(401, "Session expired — sign in again")
            session_id, agent_id, name, email, must_change, perms, idle, idle_min = row
            if idle:
                raise HTTPException(401, f"Signed out after {idle_min} minutes of "
                                         "inactivity — sign in again")
            if must_change and not allow_must_change:
                # a temp-password session may ONLY change the password (and
                # see /auth/me) — enforced HERE, not just by the browser
                # redirect, so a scripted caller can't ride the temp password
                raise HTTPException(403, "Password change required — sign in at "
                                         "/ui/index.html#change-password first")
            if request.headers.get(PASSIVE_HEADER) != "1":
                # user activity keeps the session alive; stamped at most every
                # 20 s so a burst of requests is one write
                cur.execute("""UPDATE shared.sessions SET last_seen_at = now()
                                WHERE id = %s AND (last_seen_at IS NULL
                                      OR last_seen_at < now() - interval '20 seconds')""",
                            (session_id,))
            actor = f"agent:{agent_id}"
            cur.execute("SELECT set_config('app.actor', %s, false)", (actor,))
        return {"kind": "session", "agent_id": agent_id, "name": name,
                "email": email, "perms": set(perms), "must_change": must_change,
                "actor": actor, "label": email, "idle_minutes": idle_min}

    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(401, "Sign in, or send a bearer token")
    digest = hashlib.sha256(header[7:].strip().encode()).hexdigest()
    with conn.cursor() as cur:
        # 0050 (HIPAA review #10): tokens expire, and a token dies with its
        # owner — a deactivated agent's tokens stop working immediately
        cur.execute("""SELECT t.id, t.label, t.created_by, t.scopes, o.name
                         FROM shared.api_tokens t
                         LEFT JOIN shared.agents o ON o.id = t.created_by
                        WHERE t.token_hash = %s AND t.revoked_at IS NULL
                          AND t.expires_at > now()
                          AND (t.created_by IS NULL OR o.active)""", (digest,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(401, "Invalid, expired or revoked token")
        token_id, label, created_by, scopes, owner_name = row
        cur.execute("UPDATE shared.api_tokens SET last_used_at = now() WHERE id = %s",
                    (token_id,))
        actor = f"agent:{created_by}" if created_by else f"api:{label}"
        cur.execute("SELECT set_config('app.actor', %s, false)", (actor,))
    # scopes (0001, enforced as of the audit builds): an EMPTY array is the
    # all-scope service token (perms None — the only caller that bypasses
    # visibility and own-row rules); a NON-empty array is a least-privilege
    # token held to exactly those keys, acting AS its owner (agent_id) for
    # visibility and own-row checks. Restriction checks key on
    # `who["perms"] is not None`, never on kind == "session".
    return {"kind": "pat", "perms": set(scopes) if scopes else None,
            "agent_id": created_by, "name": owner_name or label,
            "actor": actor, "label": label}


def need(who: dict, *any_of: str):
    """RBAC gate: sessions must hold at least one of the permissions; PATs
    pass when all-scope (empty scopes — service credentials) or when their
    scopes cover one. 403 mirrors the prototype's function refusals."""
    if who["kind"] == "pat" and who["perms"] is None:
        return
    if who["perms"] & set(any_of):
        return
    raise HTTPException(403, f"Your role lacks: {' or '.join(any_of)}")


def audit(conn, app: str, action: str, entity: str | None, detail: str):
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO audit.events (app, action, entity, detail)
                       VALUES (%s, %s, %s, %s)""", (app, action, entity, detail))
