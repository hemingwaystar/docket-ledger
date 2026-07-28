"""mail-worker — Graph ingestion + schedulers. Scaffold: the loop shape.
Jobs (HANDOFF §10.8/10.10/10.14): Graph subscription renewal + delta-poll
backstop, inbound routing ladder (contact → domain → catch-all + unrouted),
pending_until wakes, SLA escalation fan-out. Auto-Submitted + recursion guards
live here, not in the DB."""
import time
from . import db

INTERVAL = 30  # seconds between scheduler passes

def wake_pending(conn):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id FROM desk.tickets
            WHERE pending_until IS NOT NULL AND pending_until <= now()
        """)
        return [r[0] for r in cur.fetchall()]

def main():
    print("mail-worker up — scheduler loop every", INTERVAL, "s")
    while True:
        try:
            with db.connect("automation") as conn:
                due = wake_pending(conn)
                if due:
                    print("pending wakes due:", due)  # reopen logic lands next
                conn.commit()
        except Exception as exc:  # visibility first; retry next tick
            print("worker pass failed:", exc)
        time.sleep(INTERVAL)

if __name__ == "__main__":
    main()
