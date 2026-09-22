"""Signatures — the sign-off appended to outgoing replies (desk.signatures,
the 0001 stub wired in 0047). Two owner kinds, two RBAC rules:

  * PERSONAL (owner_kind='agent') — self-service. Every signed-in agent edits
    THEIR OWN, and only their own; no admin permission is involved (the actor
    IS the owner). PATs have no personal identity, so they can't set one.
  * BOARD    (owner_kind='group') — an admin footer for a whole board, gated on
    manage_settings like the rest of the Settings control plane.

Reads ride /api/bootstrap (the caller's own personal signature + all board
signatures, which the composer needs to append). This module owns the writes.
The composer appends the agent's personal signature then the ticket board's, if
either is set — see tickets.js sendArticle/replySignature; storage is authoritative
and the composer mirrors it optimistically, exactly like every other reply field.
"""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from . import auth, db

router = APIRouter(prefix="/api/signatures")

MAX = 4000   # a sign-off, not an article (mirrors the article body cap)


class SigBody(BaseModel):
    body: str


def _clean(raw: str) -> str:
    """Normalize newlines and trim; an empty result means 'clear it'."""
    text = (raw or "").replace("\r\n", "\n").strip()
    if len(text) > MAX:
        raise HTTPException(422, f"Signature is too long — {MAX} characters max")
    return text


@router.put("/me")
def put_my_signature(body: SigBody, request: Request):
    """Set (or, with an empty body, clear) the caller's own personal signature.
    Self-service: the actor is the owner, so no manage_* permission is checked —
    but a PAT has no agent identity to own a signature, so it's refused."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(403, "A personal signature belongs to a signed-in agent")
        text = _clean(body.body)
        with conn.cursor() as cur:
            if text:
                cur.execute("""INSERT INTO desk.signatures (owner_kind, agent_id, body)
                               VALUES ('agent', %s, %s)
                               ON CONFLICT (agent_id) WHERE owner_kind = 'agent'
                               DO UPDATE SET body = EXCLUDED.body,
                                             updated_at = now(),
                                             updated_by = shared.current_actor()""",
                            (who["agent_id"], text))
            else:
                cur.execute("""DELETE FROM desk.signatures
                                WHERE owner_kind = 'agent' AND agent_id = %s""",
                            (who["agent_id"],))
        auth.audit(conn, "desk",
                   "Signature updated" if text else "Signature cleared",
                   f"agent:{who['agent_id']}",
                   f"personal signature {'set' if text else 'cleared'} by {who['label']}")
        return {"ok": True, "body": text}


@router.put("/groups/{group_id}")
def put_group_signature(group_id: str, body: SigBody, request: Request):
    """Set (or clear) a board's shared footer. Admin only — manage_settings,
    matching the rest of the Settings control plane."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        text = _clean(body.body)
        with conn.cursor() as cur:
            cur.execute("SELECT name FROM shared.groups WHERE id::text = %s", (group_id,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such group")
            (gname,) = row
            if text:
                cur.execute("""INSERT INTO desk.signatures (owner_kind, group_id, body)
                               VALUES ('group', %s, %s)
                               ON CONFLICT (group_id) WHERE owner_kind = 'group'
                               DO UPDATE SET body = EXCLUDED.body,
                                             updated_at = now(),
                                             updated_by = shared.current_actor()""",
                            (group_id, text))
            else:
                cur.execute("""DELETE FROM desk.signatures
                                WHERE owner_kind = 'group' AND group_id = %s""",
                            (group_id,))
        auth.audit(conn, "desk",
                   "Board signature updated" if text else "Board signature cleared",
                   f"group:{group_id}",
                   f"{gname}: board signature {'set' if text else 'cleared'} ({who['label']})")
        return {"ok": True, "body": text}
