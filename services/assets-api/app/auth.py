"""Authentication for every request: a login session cookie (browsers) or a
Bearer PAT (integrations/scripts). Sessions carry the sign-in permission
snapshot and enforce RBAC via need(); PATs are trusted service credentials
(all-scope) — §10.17. Sets app.actor for the audit triggers either way."""
import hashlib
from fastapi import HTTPException, Request

COOKIE = "hts_session"


def require(conn, request: Request) -> dict:
    token = request.cookies.get(COOKIE)
    if token:
        digest = hashlib.sha256(token.encode()).hexdigest()
        with conn.cursor() as cur:
            cur.execute("""SELECT s.agent_id, s.perms, a.name, a.email,
                                  a.password_must_change
                             FROM shared.sessions s
                             JOIN shared.agents a ON a.id = s.agent_id
                            WHERE s.token_hash = %s AND s.revoked_at IS NULL
                              AND s.expires_at > now() AND a.active""", (digest,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(401, "Session expired — sign in again")
            agent_id, perms, name, email, must_change = row
            actor = f"agent:{agent_id}"
            cur.execute("SELECT set_config('app.actor', %s, false)", (actor,))
        return {"kind": "session", "agent_id": agent_id, "name": name,
                "email": email, "perms": set(perms), "must_change": must_change,
                "actor": actor, "label": email}

    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(401, "Sign in, or send a bearer token")
    digest = hashlib.sha256(header[7:].strip().encode()).hexdigest()
    with conn.cursor() as cur:
        cur.execute("""SELECT id, label, created_by FROM shared.api_tokens
                        WHERE token_hash = %s AND revoked_at IS NULL""", (digest,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(401, "Invalid or revoked token")
        token_id, label, created_by = row
        cur.execute("UPDATE shared.api_tokens SET last_used_at = now() WHERE id = %s",
                    (token_id,))
        actor = f"agent:{created_by}" if created_by else f"api:{label}"
        cur.execute("SELECT set_config('app.actor', %s, false)", (actor,))
    return {"kind": "pat", "perms": None, "actor": actor, "label": label}


def need(who: dict, *any_of: str):
    """RBAC gate: sessions must hold at least one of the permissions; PATs
    pass (service credentials). 403 mirrors the prototype's function refusals."""
    if who["kind"] == "pat":
        return
    if who["perms"] & set(any_of):
        return
    raise HTTPException(403, f"Your role lacks: {' or '.join(any_of)}")


def audit(conn, app: str, action: str, entity: str | None, detail: str):
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO audit.events (app, action, entity, detail)
                       VALUES (%s, %s, %s, %s)""", (app, action, entity, detail))
