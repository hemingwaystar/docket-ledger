"""mail-worker — schedulers + inbound mail machinery.

Live now:
  * pending-wake job (§10.10): tickets whose pending_until has passed reopen
    to Open with a sys article, actor 'automation', audited.
  * the routing ladder (§10.14) as a tested function, ready for ingestion:
    exact contact match → client-domain match (auto-creates the contact)
    → sentinel catch-all + 'unrouted' tag.

Idle until configured:
  * Graph ingestion (subscription renewal + delta-poll backstop) checks
    shared.app_config('graph').connected each pass and sleeps while false —
    consent + secrets land via the settings endpoints in a later build.
"""
import json
import time
from . import db

INTERVAL = 30


def wake_pending(conn) -> int:
    """Reopen every ticket whose pending timer has expired."""
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
                           VALUES ('mail', 'Pending wake', %s,
                                   'reopened by the scheduler')""",
                        (f"ticket:{tid}",))
    return len(woken)


def route_sender(conn, from_email: str):
    """The routing ladder. Returns (client_id, contact_id, unrouted, created).
    Step 2 auto-creates the contact inside the domain-matched client."""
    email = from_email.strip().lower()
    domain = email.split("@")[-1] if "@" in email else ""
    with conn.cursor() as cur:
        cur.execute("""SELECT c.client_id, c.id FROM shared.contacts c
                        WHERE lower(c.email) = %s AND c.active""", (email,))
        row = cur.fetchone()
        if row:
            return row[0], row[1], False, False
        cur.execute("""SELECT d.client_id FROM shared.client_domains d
                        JOIN shared.clients c ON c.id = d.client_id
                       WHERE lower(d.domain) = %s AND c.archived_at IS NULL""", (domain,))
        row = cur.fetchone()
        if row:
            client_id = row[0]
            cur.execute("""INSERT INTO shared.contacts (client_id, name, email)
                           VALUES (%s, %s, %s) RETURNING id""",
                        (client_id, email.split("@")[0].replace(".", " ").title(), email))
            (contact_id,) = cur.fetchone()
            cur.execute("""INSERT INTO audit.events (app, action, entity, detail)
                           VALUES ('mail', 'Contact auto-created', %s,
                                   %s)""",
                        (f"contact:{contact_id}", f"{email} via domain match → client"))
            return client_id, contact_id, False, True
        cur.execute("SELECT id FROM shared.clients WHERE is_sentinel")
        (sentinel,) = cur.fetchone()
        return sentinel, None, True, False


def graph_configured(conn) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT value FROM shared.app_config WHERE key = 'graph'")
        row = cur.fetchone()
    cfg = row[0] if row else {}
    if isinstance(cfg, str):
        cfg = json.loads(cfg)
    return bool(cfg.get("connected"))


def main():
    print(f"mail-worker up — scheduler every {INTERVAL}s "
          "(pending wakes live; Graph ingestion idle until consented)")
    while True:
        try:
            with db.connect("automation") as conn:
                n = wake_pending(conn)
                if n:
                    print(f"reopened {n} pending ticket(s)")
                if graph_configured(conn):
                    # ingestion lands here: renew subscriptions nearing expiry,
                    # delta-poll each active mailbox, file via route_sender()
                    pass
                conn.commit()
        except Exception as exc:
            print("worker pass failed:", exc)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
