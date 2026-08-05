"""The composer: reply/note articles with staged attachments and optional
ride-along time. Replies mail out only when the mailbox and the global
outbound switch allow — otherwise recorded only."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from .. import auth, db, helpers, mailer
from .common import _sane_span, sys_article

router = APIRouter(prefix="/api")


class TimeSpec(BaseModel):
    started_at: str
    ended_at: str
    activity_type: str
    technician_email: str
    task_id: str | None = None


class NewArticle(BaseModel):
    attachment_ids: list[str] = []
    kind: str
    body: str
    author_email: str
    to: str | None = None              # reply recipient override
    time: TimeSpec | None = None


@router.post("/tickets/{ticket_id}/articles", status_code=201)
def add_article(ticket_id: int, body: NewArticle, request: Request):
    if body.kind not in ("reply", "note"):
        raise HTTPException(422, "kind must be reply or note")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "reply" if body.kind == "reply" else "note")
        if body.time:
            auth.need(who, "log_time")
            _sane_span(body.time.started_at, body.time.ended_at)
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            client_id = row[1]
            author_id, author_name = helpers.agent(cur, body.author_email)
            sent, mail_to, out_mid, mb_addr = False, None, None, None
            if body.kind == "reply":
                # recipient: explicit override → ticket contact → last inbound sender
                cur.execute("""SELECT COALESCE(
                                 %s,
                                 (SELECT co.email FROM desk.tickets tk
                                    JOIN shared.contacts co ON co.id = tk.contact_id
                                   WHERE tk.id = %s),
                                 (SELECT ar.mail_from FROM desk.articles ar
                                   WHERE ar.ticket_id = %s AND ar.kind = 'mail_in'
                                   ORDER BY ar.sent_at DESC LIMIT 1))""",
                            (body.to, ticket_id, ticket_id))
                (mail_to,) = cur.fetchone()
                if not mail_to:
                    raise HTTPException(409, "No recipient — the ticket has no contact or inbound mail")
                # sender: group_sendas override (live + outbound, 0026) → fed-by
                # mailbox — same order as the worker's trigger mail
                cur.execute("""SELECT m.address, m.display_name, m.outbound
                                 FROM desk.group_sendas gs
                                 JOIN desk.mailboxes m ON m.id = gs.mailbox_id
                                 JOIN desk.tickets t ON t.group_id = gs.group_id
                                WHERE t.id = %s AND NOT m.paused AND m.outbound""",
                            (ticket_id,))
                mbrow = cur.fetchone()
                if mbrow is None:
                    cur.execute("""SELECT m.address, m.display_name, m.outbound
                                     FROM desk.mailboxes m
                                     JOIN desk.tickets t ON t.group_id = m.group_id
                                    WHERE t.id = %s AND NOT m.paused
                                    ORDER BY m.outbound DESC, m.address LIMIT 1""",
                                (ticket_id,))
                    mbrow = cur.fetchone()
                if mbrow is None:
                    raise HTTPException(409, "No mailbox is attached to this ticket's group")
                mb_addr, mb_name, mb_outbound = mbrow
                cur.execute("""SELECT t.title, t.cc,
                                 (SELECT ar.message_id FROM desk.articles ar
                                   WHERE ar.ticket_id = t.id AND ar.message_id IS NOT NULL
                                   ORDER BY ar.sent_at DESC LIMIT 1),
                                 COALESCE((SELECT array_agg(ar.message_id ORDER BY ar.sent_at)
                                   FROM desk.articles ar
                                  WHERE ar.ticket_id = t.id AND ar.message_id IS NOT NULL), '{}')
                                FROM desk.tickets t WHERE t.id = %s""", (ticket_id,))
                title, cc_list, last_mid, all_mids = cur.fetchone()
                if mailer.outbound_enabled(cur) and mb_outbound:
                    files = []
                    if body.attachment_ids:
                        cur.execute("""SELECT filename, mime_type, content
                                         FROM desk.attachments
                                        WHERE id = ANY(%s::uuid[])
                                          AND article_id IS NULL""",
                                    (body.attachment_ids,))
                        files = [(f, m, bytes(c)) for f, m, c in cur.fetchall()]
                    out_mid = mailer.send_reply(
                        cur, mailbox_address=mb_addr, display_name=mb_name or "",
                        to=mail_to, cc=list(cc_list or []),
                        subject=f"Service Ticket: [#{ticket_id}] {title}", body=body.body,
                        in_reply_to=last_mid, references=list(all_mids or []),
                        attachments=files)
                    sent = True
            cur.execute("""INSERT INTO desk.articles
                             (ticket_id, kind, author, author_id, body,
                              mail_from, mail_to, message_id)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                        (ticket_id, body.kind, author_name, author_id, body.body,
                         mb_addr,                     # sending mailbox on replies, None on notes
                         mail_to, out_mid))
            (article_id,) = cur.fetchone()
            if body.attachment_ids:
                cur.execute("""UPDATE desk.attachments
                                  SET article_id = %s, staged_by = NULL
                                WHERE id = ANY(%s::uuid[]) AND article_id IS NULL""",
                            (article_id, body.attachment_ids))
            entry_id, hours = None, None
            if body.time:
                t = body.time
                tech_id, _ = helpers.agent(cur, t.technician_email)
                type_id = helpers.activity_type_id(cur, t.activity_type)
                cur.execute("""INSERT INTO ledger.time_entries
                                 (ticket_id, task_id, client_id, tech_id, activity_type_id,
                                  started_at, ended_at, note, article_id)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id, hours""",
                            (ticket_id, t.task_id, client_id, tech_id, type_id,
                             t.started_at, t.ended_at, body.body[:140], article_id))
                entry_id, hours = cur.fetchone()
            # ticket-audit sibling (build 24): the ADDITION of a note/reply is a
            # ticket event too — it now shows in the ticket's Audit block with the
            # actor, not just the system Audit Log. The note/reply body itself
            # still lives in the thread; this is the compact "who did what" line.
            if body.kind == "note":
                sys_article(cur, ticket_id, who, "Internal note added")
            else:
                sys_article(cur, ticket_id, who,
                            f"Public reply sent to {mail_to}" if sent
                            else f"Public reply recorded (to {mail_to})")
            cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s", (ticket_id,))
        detail = f"#{ticket_id} · {body.kind} by {author_name}"
        if body.kind == "reply":
            detail += (f" · mailed to {mail_to}" if sent
                       else f" · to {mail_to} — RECORDED ONLY "
                            f"({'sender mailbox is receive-only' if not mb_outbound else 'outbound disabled'})")
        if entry_id:
            detail += f" · {hours} h → Ledger"
        auth.audit(conn, "desk",
                   ("Reply sent" if sent else "Reply recorded") if body.kind == "reply"
                   else "Note added",
                   f"ticket:{ticket_id}", detail)
        return {"article_id": str(article_id), "sent": sent, "to": mail_to,
                "time_entry_id": str(entry_id) if entry_id else None}
