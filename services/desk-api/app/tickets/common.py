"""Shared ticket plumbing: the canonical ticket SELECT, the prototype's
state-id map, the outbox/sys-note/link-parent helpers, and the bug-#27
span guard for every time write."""
from fastapi import HTTPException

TICKET_SELECT = """
  SELECT t.id, t.title, s.label AS state, s.kind AS state_kind,
         p.label AS priority, c.name AS client, g.name AS "group",
         a.name AS owner, t.pending_until, t.merged_into_id,
         t.is_project, t.created_at, t.updated_at, t.version,
         COALESCE((SELECT array_agg(tag ORDER BY tag)
                     FROM desk.ticket_tags tt WHERE tt.ticket_id = t.id), '{}') AS tags
    FROM desk.tickets t
    JOIN desk.ticket_states s ON s.id = t.state_id
    JOIN desk.priorities p    ON p.id = t.priority_id
    JOIN shared.clients c     ON c.id = t.client_id
    JOIN shared.groups g      ON g.id = t.group_id
    LEFT JOIN shared.agents a ON a.id = t.owner_id
"""


ST_MAP = {"new": "new", "open": "open", "pending reminder": "pending",
          "on hold": "hold", "solved": "solved", "closed": "closed",
          "archived": "archived",
          "closed: child ticket": "child-closed"}


def emit_event(cur, event: str, ticket_id: int):
    """Feed the automations outbox — the mail-worker's engine evaluates
    triggers within one scheduler pass. Manual/API mutations are never
    auto-generated mail, so meta.auto is false (email actions may run)."""
    cur.execute("""INSERT INTO desk.automation_events (event, ticket_id, meta)
                   VALUES (%s, %s, '{"auto": false}')""", (event, ticket_id))


def sys_note(cur, ticket_id: int, body: str):
    """System article on a ticket — the merge/cascade/link narration."""
    cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, body)
                   VALUES (%s, 'sys', 'Automation', %s)""", (ticket_id, body))


def live_parent_of(cur, ticket_id: int):
    """The parent id if this ticket is a live child, else None."""
    cur.execute("""SELECT src_id FROM desk.ticket_links
                    WHERE kind = 'child' AND voided_at IS NULL AND dst_id = %s""",
                (ticket_id,))
    row = cur.fetchone()
    return row[0] if row else None


def _sane_span(started: str | None, ended: str | None):
    """Bug #27: garbage years from datetime-local fields must never mint
    billing periods. Mirrors ledger's guard."""
    from datetime import datetime, timedelta, timezone
    def parse(v):
        if v is None:
            return None
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(422, f"Unparseable timestamp: {v!r}")
    st, en = parse(started), parse(ended)
    now = datetime.now(timezone.utc)
    for label, dt in (("start", st), ("end", en)):
        if dt is None:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if dt.year < 2020 or dt > now + timedelta(days=400):
            raise HTTPException(422, f"That {label} time ({dt.date()}) is outside the "
                                     "sane window — check the year")
