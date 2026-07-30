"""mail-worker — schedulers + Graph ingestion.

Every INTERVAL seconds:
  1. pending wakes (§10.10): expired pending_until → reopen + sys article
  2. if app_config('graph').connected: delta-poll every unpaused mailbox
     (application-permission client credentials; no webhooks, no inbound port)
  3. automations: drain desk.automation_events → fire ticket triggers
     (mail RULES already ran inline during ingestion, per message)
  4. SLA scan: warn/breach notices, business-hours aware, deduped

Ingestion per message — §10.8/10.14 encoded:
  * idempotent on Internet Message-ID (unique index on desk.articles)
  * Auto-Submitted / Precedence:bulk|auto → filed with is_auto, and such mail
    NEVER changes ticket state
  * thread match: [#100123] in the subject, else In-Reply-To/References
    against stored message ids → follow-up; done tickets reopen UNLESS the
    ticket is an approved locked project (follow-up filed, state untouched)
  * no match → new ticket via the routing ladder: exact contact → client
    domain (contact auto-created) → sentinel catch-all + 'unrouted' tag
Outbound send (replies via Graph) is a coming build — ingestion never sends
mail, so no auto-reply loop risk exists yet by design.
"""
import html
import json
import re
import time

import httpx

from . import automations, crypto, db

INTERVAL = 30
TOKEN_CACHE = {"token": None, "until": 0.0}
SUBJECT_REF = re.compile(r"\[#(\d{5,})\]")
TAG_STRIP = re.compile(r"<[^>]+>")


def wake_pending(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE desk.tickets t
               SET state_id = (SELECT id FROM desk.ticket_states WHERE label = 'Open'),
                   pending_until = NULL
             WHERE t.pending_until IS NOT NULL AND t.pending_until <= now()
            RETURNING t.id""")
        woken = [r[0] for r in cur.fetchall()]
        for tid in woken:
            cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, body, is_auto)
                           VALUES (%s, 'sys', 'Automation',
                                   'Pending timer elapsed — reopened automatically', true)""",
                        (tid,))
            cur.execute("""INSERT INTO audit.events (app, action, entity, detail)
                           VALUES ('mail', 'Pending wake', %s, 'reopened by the scheduler')""",
                        (f"ticket:{tid}",))
    return len(woken)


def route_sender(conn, from_email: str):
    email = (from_email or "").strip().lower()
    domain = email.split("@")[-1] if "@" in email else ""
    with conn.cursor() as cur:
        cur.execute("""SELECT c.client_id, c.id FROM shared.contacts c
                        WHERE lower(c.email) = %s AND c.active""", (email,))
        row = cur.fetchone()
        if row:
            return row[0], row[1], False
        cur.execute("""SELECT d.client_id FROM shared.client_domains d
                        JOIN shared.clients c ON c.id = d.client_id
                       WHERE lower(d.domain) = %s AND c.archived_at IS NULL""", (domain,))
        row = cur.fetchone()
        if row:
            client_id = row[0]
            name = email.split("@")[0].replace(".", " ").replace("_", " ").title()
            cur.execute("""INSERT INTO shared.contacts (client_id, name, email)
                           VALUES (%s, %s, %s) RETURNING id""", (client_id, name, email))
            (contact_id,) = cur.fetchone()
            cur.execute("""INSERT INTO audit.events (app, action, entity, detail)
                           VALUES ('mail', 'Contact auto-created', %s, %s)""",
                        (f"contact:{contact_id}", f"{email} via domain match"))
            return client_id, contact_id, False
        cur.execute("SELECT id FROM shared.clients WHERE is_sentinel")
        (sentinel,) = cur.fetchone()
        return sentinel, None, True


def graph_config(conn) -> dict:
    with conn.cursor() as cur:
        cur.execute("SELECT value FROM shared.app_config WHERE key = 'graph'")
        row = cur.fetchone()
    cfg = row[0] if row else {}
    return json.loads(cfg) if isinstance(cfg, str) else (cfg or {})


def graph_token(conn, cfg):
    if TOKEN_CACHE["token"] and time.time() < TOKEN_CACHE["until"] - 120:
        return TOKEN_CACHE["token"]
    with conn.cursor() as cur:
        cur.execute("SELECT ciphertext FROM shared.secrets WHERE name = 'graph'")
        row = cur.fetchone()
    if row is None or not cfg.get("tenant") or not cfg.get("client_id"):
        return None
    secret = crypto.open_(row[0]).decode()
    resp = httpx.post(
        f"https://login.microsoftonline.com/{cfg['tenant']}/oauth2/v2.0/token",
        data={"grant_type": "client_credentials", "client_id": cfg["client_id"],
              "client_secret": secret,
              "scope": "https://graph.microsoft.com/.default"}, timeout=15)
    resp.raise_for_status()
    body = resp.json()
    TOKEN_CACHE["token"] = body["access_token"]
    TOKEN_CACHE["until"] = time.time() + int(body.get("expires_in", 3599))
    return TOKEN_CACHE["token"]


BLOCK_TAGS = re.compile(r"(?i)<\s*(?:br|/p|/div|/tr|/li|/h[1-6])\s*/?\s*>")


def body_text(msg) -> str:
    """Plain-text body. Block-level tags become newlines BEFORE stripping so
    paragraphs survive; runs of blank lines collapse to one."""
    body = msg.get("body") or {}
    content = body.get("content", "") or msg.get("bodyPreview", "")
    if (body.get("contentType") or "").lower() == "html":
        content = BLOCK_TAGS.sub("\n", content)
        content = html.unescape(TAG_STRIP.sub(" ", content))
    content = re.sub(r"[ \t]+", " ", content)
    content = re.sub(r"\n\s*\n+", "\n\n", content)
    return content.strip()[:20000]


def body_html(msg) -> str | None:
    """The original HTML, when the message is HTML — rendered sandboxed."""
    body = msg.get("body") or {}
    if (body.get("contentType") or "").lower() != "html":
        return None
    return (body.get("content") or "")[:300000] or None


def is_auto_mail(msg) -> bool:
    for h in msg.get("internetMessageHeaders") or []:
        n, v = h.get("name", "").lower(), h.get("value", "").lower()
        if n == "auto-submitted" and v != "no":
            return True
        if n == "precedence" and v in ("bulk", "auto_reply", "junk"):
            return True
        if n == "x-auto-response-suppress":
            return True
    return False


def find_thread(cur, msg):
    m = SUBJECT_REF.search(msg.get("subject") or "")
    if m:
        cur.execute("SELECT id FROM desk.tickets WHERE id = %s", (int(m.group(1)),))
        if cur.fetchone():
            return int(m.group(1))
    for h in msg.get("internetMessageHeaders") or []:
        if h.get("name", "").lower() in ("in-reply-to", "references"):
            for ref in h.get("value", "").split():
                cur.execute("SELECT ticket_id FROM desk.articles WHERE message_id = %s",
                            (ref.strip(),))
                row = cur.fetchone()
                if row:
                    return row[0]
    return None


def ingest_message(conn, mailbox, msg) -> str:
    mid = msg.get("internetMessageId")
    sender = (((msg.get("from") or {}).get("emailAddress")) or {}).get("address", "")
    subject = (msg.get("subject") or "").strip() or "(no subject)"
    auto = is_auto_mail(msg)
    with conn.cursor() as cur:
        if mid:
            cur.execute("SELECT 1 FROM desk.articles WHERE message_id = %s", (mid,))
            if cur.fetchone():
                return "dup"
        ticket_id = find_thread(cur, msg)
        status = "followup"
        if ticket_id is None:
            status = "new"
            client_id, contact_id, unrouted = route_sender(conn, sender)
            cur.execute("""INSERT INTO desk.tickets
                             (title, client_id, contact_id, group_id, state_id, priority_id)
                           VALUES (%s, %s, %s, %s,
                                   (SELECT id FROM desk.ticket_states WHERE label = 'New'),
                                   COALESCE(%s, (SELECT id FROM desk.priorities
                                                  WHERE label = 'Normal')))
                           RETURNING id""",
                        (subject[:300], client_id, contact_id, mailbox["group_id"],
                         mailbox["default_priority_id"]))
            (ticket_id,) = cur.fetchone()
            if unrouted:
                cur.execute("""INSERT INTO desk.ticket_tags (ticket_id, tag)
                               VALUES (%s, 'unrouted') ON CONFLICT DO NOTHING""", (ticket_id,))
            cur.execute("""INSERT INTO audit.events (app, action, entity, detail)
                           VALUES ('mail', 'Ticket created from mail', %s, %s)""",
                        (f"ticket:{ticket_id}",
                         f"#{ticket_id} “{subject[:80]}” from {sender}"
                         + (" — unrouted" if unrouted else "")))
        cur.execute("""INSERT INTO desk.articles
                         (ticket_id, kind, author, mail_from, mail_to, message_id,
                          body, body_html, is_auto, sent_at)
                       VALUES (%s, 'mail_in', %s, %s, %s, %s, %s, %s,
                               COALESCE(%s, now()))""",
                    (ticket_id, sender or "unknown", sender, mailbox["address"], mid,
                     body_text(msg), body_html(msg), auto,
                     msg.get("receivedDateTime")))
        if status == "followup" and not auto:
            cur.execute("""
                UPDATE desk.tickets t
                   SET state_id = (SELECT id FROM desk.ticket_states WHERE label = 'Open'),
                       pending_until = NULL
                 WHERE t.id = %s
                   AND (SELECT s.kind FROM desk.ticket_states s WHERE s.id = t.state_id) = 'done'
                   AND NOT EXISTS (SELECT 1 FROM desk.projects p
                                    WHERE p.ticket_id = t.id
                                      AND p.status = 'approved' AND NOT p.unlocked)
                RETURNING t.id""", (ticket_id,))
            if cur.fetchone():
                cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, body, is_auto)
                               VALUES (%s, 'sys', 'Automation',
                                       'Reopened — customer replied on a closed ticket', true)""",
                            (ticket_id,))
        cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s", (ticket_id,))
    # automations: rules run on EVERY inbound message (top to bottom, later
    # rules see earlier changes), then the matching trigger event is queued.
    # meta.auto rides along so trigger email actions can refuse to answer
    # auto-generated mail — the loop guard.
    meta = {"from": sender, "to": mailbox["address"], "subject": subject,
            "body": body_text(msg), "auto": auto}
    try:
        automations.apply_mail_rules(conn, ticket_id, meta)
    except Exception as exc:
        print(f"mail rules failed on #{ticket_id}: {exc}")
    with conn.cursor() as cur:
        automations.enqueue(cur, "create" if status == "new" else "followup",
                            ticket_id, meta)
    return status


def poll_mailbox(conn, token, mailbox) -> dict:
    select = ("subject,from,receivedDateTime,body,bodyPreview,"
              "internetMessageId,internetMessageHeaders")
    with conn.cursor() as cur:
        cur.execute("SELECT delta_link FROM desk.graph_subscriptions WHERE mailbox_id = %s",
                    (mailbox["id"],))
        row = cur.fetchone()
    url = (row[0] if row and row[0] else
           f"https://graph.microsoft.com/v1.0/users/{mailbox['address']}"
           f"/mailFolders/inbox/messages/delta?$select={select}")
    headers = {"Authorization": f"Bearer {token}", "Prefer": "odata.maxpagesize=25"}
    counts = {"new": 0, "followup": 0, "dup": 0}
    for _ in range(20):
        resp = httpx.get(url, headers=headers, timeout=30)
        if resp.status_code == 410:      # delta cursor expired — restart clean
            url = (f"https://graph.microsoft.com/v1.0/users/{mailbox['address']}"
                   f"/mailFolders/inbox/messages/delta?$select={select}")
            continue
        resp.raise_for_status()
        page = resp.json()
        for msg in page.get("value", []):
            if "@removed" in msg:
                continue
            counts[ingest_message(conn, mailbox, msg)] += 1
        if "@odata.nextLink" in page:
            url = page["@odata.nextLink"]
            continue
        delta = page.get("@odata.deltaLink")
        if delta:
            with conn.cursor() as cur:
                cur.execute("""INSERT INTO desk.graph_subscriptions
                                 (mailbox_id, delta_link, last_delta_at)
                               VALUES (%s, %s, now())
                               ON CONFLICT (mailbox_id) DO UPDATE
                                 SET delta_link = EXCLUDED.delta_link,
                                     last_delta_at = now()""",
                            (mailbox["id"], delta))
        break
    return counts


def poll_all(conn):
    cfg = graph_config(conn)
    if not cfg.get("connected"):
        return
    token = graph_token(conn, cfg)
    if not token:
        return
    with conn.cursor() as cur:
        cur.execute("""SELECT id, address, group_id, default_priority_id
                         FROM desk.mailboxes WHERE NOT paused""")
        boxes = [{"id": r[0], "address": r[1], "group_id": r[2],
                  "default_priority_id": r[3]} for r in cur.fetchall()]
    for mb in boxes:
        try:
            counts = poll_mailbox(conn, token, mb)
            if counts["new"] or counts["followup"]:
                print(f"{mb['address']}: {counts['new']} new, "
                      f"{counts['followup']} follow-ups")
        except Exception as exc:
            print(f"poll failed for {mb['address']}: {exc}")


def main():
    print(f"mail-worker up — every {INTERVAL}s: pending wakes + Graph delta poll "
          "(idle until config/graph.connected)")
    while True:
        try:
            with db.connect("automation") as conn:
                n = wake_pending(conn)
                if n:
                    print(f"reopened {n} pending ticket(s)")
                poll_all(conn)
                fired = automations.process_events(conn)
                if fired:
                    print(f"evaluated {fired} automation event(s)")
                sla = automations.sla_pass(conn)
                if sla:
                    print(f"sent {sla} SLA notice(s)")
                conn.commit()
        except Exception as exc:
            print("worker pass failed:", exc)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
