"""PAT authentication — HANDOFF §10.17.
Bearer tokens, sha256-hashed at rest in shared.api_tokens, plaintext shown
once at creation (scripts/create-token.sh). 401 semantics mirror the
prototype's Try-it console: missing/unknown/revoked → 401 with a plain body.
Scopes are stored but not yet enforced (single-tenant, all-scope for now)."""
import hashlib
from fastapi import HTTPException, Request


def require(conn, request: Request) -> dict:
    """Validate the Bearer token on this request against shared.api_tokens.
    Returns {id, label, actor}. Raises 401 otherwise. Stamps last_used_at."""
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = header[7:].strip()
    digest = hashlib.sha256(token.encode()).hexdigest()
    with conn.cursor() as cur:
        cur.execute(
            """SELECT t.id, t.label, t.created_by
                 FROM shared.api_tokens t
                WHERE t.token_hash = %s AND t.revoked_at IS NULL""",
            (digest,),
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(401, "Invalid or revoked token")
        token_id, label, created_by = row
        cur.execute(
            "UPDATE shared.api_tokens SET last_used_at = now() WHERE id = %s",
            (token_id,),
        )
        actor = f"agent:{created_by}" if created_by else f"api:{label}"
        cur.execute("SELECT set_config('app.actor', %s, false)", (actor,))
    return {"id": str(token_id), "label": label, "actor": actor}


def audit(conn, app: str, action: str, entity: str | None, detail: str):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO audit.events (app, action, entity, detail)
               VALUES (%s, %s, %s, %s)""",
            (app, action, entity, detail),
        )
