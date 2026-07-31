"""Transactional ticket merge (HANDOFF §10.11): thread, open-period time,
tags and cc move to the target; the source becomes a closed stub."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from .. import auth, db, helpers

router = APIRouter(prefix="/api")


class MergeSpec(BaseModel):
    into: int


@router.post("/tickets/{ticket_id}/merge")
def merge(ticket_id: int, body: MergeSpec, request: Request):
    """Transactional merge (§10.11): thread + open-period time + tags + cc move
    to the target; the source becomes a closed stub pointing at it. Entries in
    approved/exported periods are already billed under the source number and
    stay put (the DB would refuse anyway) — noted in the sys article.
    Merging INTO a project is refused: project time must sit under a task."""
    if body.into == ticket_id:
        raise HTTPException(422, "Cannot merge a ticket into itself")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'edit_props')
        with conn.cursor() as cur:
            src = helpers.ticket_or_404(cur, ticket_id)
            dst = helpers.ticket_or_404(cur, body.into)
            helpers.refuse_if_locked_project(src)
            if src[4]:
                raise HTTPException(409, "Source is already merged")
            if dst[2]:
                raise HTTPException(422, "Cannot merge into a project ticket — its time needs tasks")
            # parent/child links (0025) would dangle on a merged stub — unlink first
            for side, label in ((ticket_id, "Source"), (body.into, "Target")):
                cur.execute("""SELECT 1 FROM desk.ticket_links
                                WHERE kind = 'child' AND voided_at IS NULL
                                  AND (src_id = %s OR dst_id = %s) LIMIT 1""", (side, side))
                if cur.fetchone():
                    raise HTTPException(409, f"{label} #{side} has parent/child links — "
                                        "unlink them before merging")
            cur.execute("UPDATE desk.articles SET ticket_id = %s WHERE ticket_id = %s",
                        (body.into, ticket_id))
            moved_articles = cur.rowcount
            cur.execute("""UPDATE ledger.time_entries e SET ticket_id = %s
                            FROM ledger.billing_periods bp
                           WHERE bp.id = e.period_id AND bp.status = 'open'
                             AND e.ticket_id = %s""", (body.into, ticket_id))
            moved_time = cur.rowcount
            cur.execute("SELECT count(*) FROM ledger.time_entries WHERE ticket_id = %s",
                        (ticket_id,))
            (stayed,) = cur.fetchone()
            cur.execute("""INSERT INTO desk.ticket_tags (ticket_id, tag)
                           SELECT %s, tag FROM desk.ticket_tags WHERE ticket_id = %s
                           ON CONFLICT DO NOTHING""", (body.into, ticket_id))
            cur.execute("DELETE FROM desk.ticket_tags WHERE ticket_id = %s", (ticket_id,))
            cur.execute("""UPDATE desk.tickets d
                              SET cc = (SELECT array(SELECT DISTINCT x FROM unnest(d.cc || s.cc) x))
                             FROM desk.tickets s
                            WHERE d.id = %s AND s.id = %s""", (body.into, ticket_id))
            cur.execute("""UPDATE desk.tickets
                              SET merged_into_id = %s, state_id = %s, pending_until = NULL
                            WHERE id = %s""",
                        (body.into, helpers.state_id(cur, "Closed"), ticket_id))
            note = (f"Merged from #{ticket_id}: {moved_articles} articles, "
                    f"{moved_time} time entries moved"
                    + (f"; {stayed} stayed (billed in locked periods)" if stayed else ""))
            cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, body)
                           VALUES (%s, 'sys', 'Automation', %s)""", (body.into, note))
            cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, body)
                           VALUES (%s, 'sys', 'Automation',
                                   %s)""",
                        (ticket_id, f"Merged into #{body.into} — this ticket is a closed stub"))
            cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id IN (%s, %s)",
                        (ticket_id, body.into))
        auth.audit(conn, "desk", "Ticket merged", f"ticket:{ticket_id}",
                   f"#{ticket_id} → #{body.into} · {note}")
        return {"ok": True, "moved_articles": moved_articles,
                "moved_time_entries": moved_time, "locked_entries_kept": stayed}
