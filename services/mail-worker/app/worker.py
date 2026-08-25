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

import base64
import httpx
import psycopg

from . import automations, crypto, db

INTERVAL = 30
TOKEN_CACHE = {"token": None, "until": 0.0}
SUBJECT_REF = re.compile(r"\[#(\d{5,})\]")
TAG_STRIP = re.compile(r"<[^>]+>")


def _clean(s):
    """Postgres text rejects NUL — a \\x00 anywhere in sender-controlled text
    (subject, body, filename) fails the INSERT. Strip it at the door."""
    return s.replace("\x00", "") if isinstance(s, str) else s


MIME_SHAPE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$")


def normalize_mime(raw) -> str:
    """The Graph contentType is sender-chosen — never store it verbatim.
    Lowercase, drop parameters, and anything not shaped like a media type
    becomes octet-stream. Serving stays gated by desk-api's inline allowlist;
    this keeps garbage out of the column."""
    mime = (raw or "").split(";")[0].strip().lower()
    return mime if MIME_SHAPE.match(mime) else "application/octet-stream"


def wake_pending(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE desk.tickets t
               SET state_id = (SELECT id FROM desk.ticket_states WHERE label = 'Open'),
                   pending_until = NULL
             WHERE t.pending_until IS NOT NULL AND t.pending_until <= now()
               AND (SELECT s.kind FROM desk.ticket_states s
                     WHERE s.id = t.state_id) = 'paused'
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
            # contacts_email_key is unconditional on lower(email), but the
            # lookup above filters c.active — mail from a DEACTIVATED contact
            # reaches this INSERT and must not blow up the ingestion tx.
            # Adopt the existing row (its own client) instead of creating.
            cur.execute("""INSERT INTO shared.contacts (client_id, name, email)
                           VALUES (%s, %s, %s)
                           ON CONFLICT (lower(email)) DO NOTHING
                           RETURNING id""", (client_id, name, email))
            created = cur.fetchone()
            if created is None:
                cur.execute("""SELECT c.client_id, c.id FROM shared.contacts c
                                WHERE lower(c.email) = %s""", (email,))
                return (*cur.fetchone(), False)
            (contact_id,) = created
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
    return _clean(content).strip()[:20000]


def body_html(msg) -> str | None:
    """The original HTML, when the message is HTML — rendered sandboxed."""
    body = msg.get("body") or {}
    if (body.get("contentType") or "").lower() != "html":
        return None
    return _clean(body.get("content") or "")[:300000] or None


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
            for ref in _clean(h.get("value", "")).split():
                cur.execute("SELECT ticket_id FROM desk.articles WHERE message_id = %s",
                            (ref.strip(),))
                row = cur.fetchone()
                if row:
                    return row[0]
    return None


def ingest_message(conn, mailbox, msg, token=None) -> str:
    mid = _clean(msg.get("internetMessageId"))
    sender = _clean((((msg.get("from") or {}).get("emailAddress")) or {}).get("address", ""))
    subject = _clean(msg.get("subject") or "").strip() or "(no subject)"
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
                       VALUES (%s, 'mail_in', %s, %s, %s, %s, %s, %s, %s,
                               COALESCE(%s, now())) RETURNING id""",
                    (ticket_id, sender or "unknown", sender, mailbox["address"], mid,
                     body_text(msg), body_html(msg), auto,
                     msg.get("receivedDateTime")))
        (article_id,) = cur.fetchone()
        if msg.get("hasAttachments") and token:
            ingest_attachments(cur, mailbox["address"], msg.get("id"),
                               article_id, token)
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
    # savepoint fence (bug #29 class): rules are optional work riding inside
    # the ingestion transaction — a SQL failure in here would otherwise leave
    # the tx aborted, killing the enqueue below and the whole pass's commit.
    with conn.cursor() as cur:
        cur.execute("SAVEPOINT rules")
        try:
            automations.apply_mail_rules(conn, ticket_id, meta)
            cur.execute("RELEASE SAVEPOINT rules")
        except Exception as exc:                          # noqa: BLE001
            cur.execute("ROLLBACK TO SAVEPOINT rules")
            print(f"mail rules failed on #{ticket_id}: {exc}", flush=True)
    with conn.cursor() as cur:
        automations.enqueue(cur, "create" if status == "new" else "followup",
                            ticket_id, meta)
    return status


MAX_ATTACHMENT = 20 * 1024 * 1024


def ingest_attachments(cur, address, graph_msg_id, article_id, token):
    """Store the message's fileAttachments on its article. Fenced (bug #29
    discipline): attachments are optional work — a Graph hiccup here logs
    and moves on, it never takes the already-inserted article down with it.
    Oversized and non-file (item/reference) attachments are skipped."""
    try:
        resp = httpx.get(
            f"https://graph.microsoft.com/v1.0/users/{address}/messages/"
            f"{graph_msg_id}/attachments",
            headers={"Authorization": f"Bearer {token}"}, timeout=30)
        resp.raise_for_status()
        items = resp.json().get("value", [])
    except Exception as exc:                              # noqa: BLE001
        print(f"[attach] fetch failed for article {article_id}: {exc}", flush=True)
        return
    for a in items:
        if a.get("@odata.type") != "#microsoft.graph.fileAttachment":
            continue                                      # item/reference kinds
        if int(a.get("size") or 0) > MAX_ATTACHMENT:
            print(f"[attach] skipped oversized {a.get('name')!r} "
                  f"({a.get('size')} bytes)", flush=True)
            continue
        try:
            data = base64.b64decode(a.get("contentBytes") or "")
        except Exception:
            continue
        if not data:
            continue
        # savepoint per file: a bad INSERT must not poison the ingestion
        # transaction it rides in (bug #29's failure class — a caught
        # exception still leaves the tx failed without one)
        cur.execute("SAVEPOINT att")
        try:
            cur.execute("""INSERT INTO desk.attachments
                             (article_id, filename, mime_type, byte_size, content,
                              content_id, is_inline)
                           VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                        (article_id, _clean(a.get("name")) or "attachment",
                         normalize_mime(a.get("contentType")),
                         len(data), data, _clean(a.get("contentId")),
                         bool(a.get("isInline"))))
            cur.execute("RELEASE SAVEPOINT att")
        except Exception as exc:                          # noqa: BLE001
            cur.execute("ROLLBACK TO SAVEPOINT att")
            print(f"[attach] insert failed for {a.get('name')!r}: {exc}",
                  flush=True)


def sweep_staged_uploads(conn) -> int:
    """Delete composer uploads never linked to an article after a day —
    the ONE sanctioned DELETE (0023): staged orphans are internal garbage,
    not business data."""
    with conn.cursor() as cur:
        cur.execute("""DELETE FROM desk.attachments
                        WHERE article_id IS NULL
                          AND created_at < now() - interval '24 hours'""")
        return cur.rowcount


def poll_mailbox(conn, token, mailbox) -> dict:
    select = ("subject,from,receivedDateTime,body,bodyPreview,"
              "internetMessageId,internetMessageHeaders,hasAttachments")
    with conn.cursor() as cur:
        cur.execute("SELECT delta_link FROM desk.graph_subscriptions WHERE mailbox_id = %s",
                    (mailbox["id"],))
        row = cur.fetchone()
    url = (row[0] if row and row[0] else
           f"https://graph.microsoft.com/v1.0/users/{mailbox['address']}"
           f"/mailFolders/inbox/messages/delta?$select={select}")
    headers = {"Authorization": f"Bearer {token}", "Prefer": "odata.maxpagesize=25"}
    counts = {"new": 0, "followup": 0, "dup": 0, "failed": 0}
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
            # savepoint per MESSAGE (bug #29's class, one level up): without
            # this, one poison email aborts the pass's shared tx, the commit
            # below becomes a rollback, the delta cursor never advances, and
            # the identical crash repeats every 30s — intake wedged for good.
            # Fenced, the bad message is skipped WITH a durable audit trace
            # and the cursor moves past it.
            with conn.cursor() as cur:
                cur.execute("SAVEPOINT msg")
            try:
                counts[ingest_message(conn, mailbox, msg, token)] += 1
                with conn.cursor() as cur:
                    cur.execute("RELEASE SAVEPOINT msg")
            except psycopg.OperationalError:
                # transient, not poison (deadlock loser, lock/serialization
                # failure, dying connection): re-raise so the mailbox fence
                # rolls back WITHOUT advancing the delta cursor — the message
                # is retried next pass instead of silently dropped forever
                raise
            except Exception as exc:                      # noqa: BLE001
                counts["failed"] += 1
                with conn.cursor() as cur:
                    cur.execute("ROLLBACK TO SAVEPOINT msg")
                    try:   # the trace must never re-poison the restored tx
                        cur.execute("""INSERT INTO audit.events (app, action, entity, detail)
                                       VALUES ('mail', 'Message ingest FAILED', %s, %s)""",
                                    (f"mailbox:{mailbox['address']}",
                                     _clean(f"skipped {msg.get('internetMessageId') or '(no id)'} "
                                            f"“{(msg.get('subject') or '')[:120]}” — {exc}")[:1000]))
                    except Exception:                     # noqa: BLE001
                        cur.execute("ROLLBACK TO SAVEPOINT msg")
                    cur.execute("RELEASE SAVEPOINT msg")
                print(f"[ingest] skipped poison message in {mailbox['address']}: "
                      f"{exc}", flush=True)
        if "@odata.nextLink" in page:
            url = page["@odata.nextLink"]
            continue
        delta = page.get("@odata.deltaLink")
        if delta:
            _save_cursor(conn, mailbox["id"], delta)
        break
    else:
        # 20 pages (500 messages) exhausted mid-enumeration: persist the
        # nextLink so the next pass RESUMES here. Without this, a first sync
        # (or 410 reset) of a >500-message inbox refetched the same first
        # 500 every 30s forever and never ingested anything past them (audit).
        _save_cursor(conn, mailbox["id"], url)
    return counts


def _save_cursor(conn, mailbox_id, link):
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO desk.graph_subscriptions
                         (mailbox_id, delta_link, last_delta_at)
                       VALUES (%s, %s, now())
                       ON CONFLICT (mailbox_id) DO UPDATE
                         SET delta_link = EXCLUDED.delta_link,
                             last_delta_at = now()""",
                    (mailbox_id, link))


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
        # savepoint per MAILBOX: anything escaping the per-message fence
        # (delta-link upsert, cursor reads) must not leave the shared tx
        # aborted — that would fail every later mailbox and turn the pass's
        # final commit into a silent rollback.
        with conn.cursor() as cur:
            cur.execute("SAVEPOINT box")
        try:
            counts = poll_mailbox(conn, token, mb)
            with conn.cursor() as cur:
                cur.execute("RELEASE SAVEPOINT box")
            if counts["new"] or counts["followup"] or counts["failed"]:
                print(f"{mb['address']}: {counts['new']} new, "
                      f"{counts['followup']} follow-ups"
                      + (f", {counts['failed']} FAILED (see audit log)"
                         if counts["failed"] else ""))
        except Exception as exc:
            with conn.cursor() as cur:
                cur.execute("ROLLBACK TO SAVEPOINT box")
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
                conn.commit()          # ingestion + wakes land NO MATTER WHAT
                # engine passes are fenced (bug #29): a failure here must
                # never poison — let alone roll back — the mail pass above
                try:
                    fired = automations.process_events(conn)
                    if fired:
                        print(f"evaluated {fired} automation event(s)")
                    sla = automations.sla_pass(conn)
                    if sla:
                        print(f"sent {sla} SLA notice(s)")
                    conn.commit()
                except Exception as exc:
                    print("automation pass failed:", exc)
                    conn.rollback()
                # housekeeping, fenced the same way
                try:
                    swept = sweep_staged_uploads(conn)
                    if swept:
                        print(f"swept {swept} stale staged upload(s)")
                    conn.commit()
                except Exception as exc:
                    print("staged-upload sweep failed:", exc)
                    conn.rollback()
        except Exception as exc:
            print("worker pass failed:", exc)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
