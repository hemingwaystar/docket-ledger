"""The automations engine — executes what the Docket builders store.

Rules live in desk.automation_rules exactly as the prototype UI shapes them
(bug #22's lesson applied up front: the server speaks the PROTOTYPE'S
vocabulary at this boundary, translating to database ids internally):

  mail_rule  conditions: [{field: from|fromDomain|to|subject|text,
                           op: is|contains, value: "a, b, c" (any-of)}]
             actions:    {groupId, prio, prioAtLeast, tag, notify}  (one object)

  trigger    event: create|followup|state|priority|owner (+event_value =
             prototype state id for state triggers)
             conditions: [{field: state|priority|group|client|tags|from|
                                  mailbox|vip,
                           op: is|is not|contains|not contains,
                           value: "a, b, c" (any-of)}]
             — values compare against LABELS/NAMES (state label, priority
             label, group name, client name), just like trigCondMatch:
             is/contains hit on ANY comma-separated value, is not/not
             contains only when NONE do; a lone value is a one-element any-of.
             vip compares the ticket contact's VIP flag as "yes"/"no".
             actions:    [{type: email|note|tag|state|prio|group|autoassign,
                           value}] — state action value is a prototype state
             id; prio is a rank number; group is a group uuid.

Three entry points, all called by worker.py:
  apply_mail_rules(conn, ticket_id, meta)   — during ingestion, per message
  process_events(conn)                      — drains desk.automation_events
  sla_pass(conn)                            — warns/breaches, deduped

Recursion guard: trigger actions that change state/priority/owner enqueue the
follow-on event at depth+1; evaluation stops at depth 3. Loop guard: email
actions never run for events born from auto-generated mail (meta.auto).
"""
import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from . import mailer

MAX_DEPTH = 3


def _hournum(v, default):
    """Business-hours boundary as fractional hours. Tolerates every shape any
    writer has ever produced (bug #29): 8, 8.5, "8", "08:00", "18:30"."""
    try:
        if isinstance(v, str) and ":" in v:
            h, m = (v.split(":") + ["0"])[:2]
            return float(h) + (float(m) if m else 0) / 60
        return float(v)
    except (TypeError, ValueError):
        return default


def _daynums(v):
    out = []
    for d in (v if isinstance(v, list) else []):
        try:
            out.append(int(d))
        except (TypeError, ValueError):
            pass
    return out or [1, 2, 3, 4, 5]

# prototype state ids by lowercased label — the reverse of desk-api's ST_MAP.
# MUST stay in lockstep with tickets/common.py ST_MAP: the builder saves the
# bootstrap's slug, so any label desk maps specially has to map the same here
# ('closed: child ticket' → 'child-closed' was the drift that made child-closed
# state triggers never fire — audit).
PROTO_STATE = {"new": "new", "open": "open", "pending reminder": "pending",
               "on hold": "hold", "solved": "solved", "closed": "closed",
               "archived": "archived",
               "closed: child ticket": "child-closed"}


def _jload(v):
    return json.loads(v) if isinstance(v, str) else (v or None)


def _config(cur, key, default):
    cur.execute("SELECT value FROM shared.app_config WHERE key = %s", (key,))
    row = cur.fetchone()
    val = _jload(row[0]) if row else None
    return val if isinstance(val, dict) else default


def _audit(cur, action, ticket_id, detail):
    cur.execute("""INSERT INTO audit.events (app, action, entity, detail)
                   VALUES ('mail', %s, %s, %s)""",
                (action, f"ticket:{ticket_id}", detail))


def _sys_article(cur, ticket_id, author, body):
    cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, body, is_auto)
                   VALUES (%s, 'sys', %s, %s, true)""", (ticket_id, author, body))


def _notify(cur, kind, body, ticket_id=None, group_id=None, agent_id=None):
    cur.execute("""INSERT INTO desk.notifications (kind, body, ticket_id, group_id, agent_id)
                   VALUES (%s, %s, %s, %s, %s)""",
                (kind, body, ticket_id, group_id, agent_id))


def _bump_runs(cur, rule_id):
    cur.execute("UPDATE desk.automation_rules SET runs = runs + 1 WHERE id = %s",
                (rule_id,))


def _rules(cur, kind):
    cur.execute("""SELECT id, name, event, event_value, conditions, actions
                     FROM desk.automation_rules
                    WHERE kind = %s AND enabled AND NOT archived
                    ORDER BY position, created_at""", (kind,))
    out = []
    for rid, name, event, ev, conds, acts in cur.fetchall():
        out.append({"id": rid, "name": name, "event": event, "event_value": ev or "",
                    "conds": _jload(conds) or [], "actions": _jload(acts) or []})
    return out


def enqueue(cur, event, ticket_id, meta=None, depth=0):
    if depth >= MAX_DEPTH:
        return
    cur.execute("""INSERT INTO desk.automation_events (event, ticket_id, meta, depth)
                   VALUES (%s, %s, %s, %s)""",
                (event, ticket_id, json.dumps(meta or {}), depth))


def _cond_groups(conds):
    """Conditions → list of AND-groups that OR together.
    Legacy flat list = one group; empty/None = no groups (match always).
    The builder saves a single group FLAT, so old rules and new
    one-group rules share a shape."""
    if not conds:
        return []
    if all(isinstance(c, list) for c in conds):
        return [g for g in conds if g]
    return [conds]


def _match(conds, pred) -> bool:
    """True when any group's conditions ALL pass (or there are no groups)."""
    groups = _cond_groups(conds)
    return (not groups) or any(all(pred(c) for c in g) for g in groups)


# --------------------------------------------------------------------------
# ticket context — everything conditions and templates can reference
# --------------------------------------------------------------------------
def _ctx(cur, ticket_id):
    cur.execute("""
        SELECT t.id, t.title, t.client_id, t.group_id, t.owner_id, t.contact_id,
               s.label AS state_label, p.rank AS prio_rank, p.label AS prio_label,
               g.name AS group_name, c.name AS client_name,
               co.name AS contact_name, co.email AS contact_email,
               co.vip AS contact_vip,
               ag.name AS owner_name,
               COALESCE((SELECT array_agg(tag ORDER BY tag)
                          FROM desk.ticket_tags tt WHERE tt.ticket_id = t.id), '{}') AS tags,
               (SELECT ar.mail_to FROM desk.articles ar
                 WHERE ar.ticket_id = t.id AND ar.kind = 'mail_in'
                 ORDER BY ar.sent_at DESC LIMIT 1) AS inbound_to,
               (SELECT ar.mail_from FROM desk.articles ar
                 WHERE ar.ticket_id = t.id AND ar.kind = 'mail_in'
                 ORDER BY ar.sent_at DESC LIMIT 1) AS last_sender
          FROM desk.tickets t
          JOIN desk.ticket_states s ON s.id = t.state_id
          JOIN desk.priorities p ON p.id = t.priority_id
          JOIN shared.groups g ON g.id = t.group_id
          LEFT JOIN shared.clients c ON c.id = t.client_id
          LEFT JOIN shared.contacts co ON co.id = t.contact_id
          LEFT JOIN shared.agents ag ON ag.id = t.owner_id
         WHERE t.id = %s""", (ticket_id,))
    row = cur.fetchone()
    if row is None:
        return None
    cols = ("id", "title", "client_id", "group_id", "owner_id", "contact_id",
            "state_label", "prio_rank", "prio_label", "group_name", "client_name",
            "contact_name", "contact_email", "contact_vip", "owner_name", "tags",
            "inbound_to", "last_sender")
    c = dict(zip(cols, row))
    c["proto_state"] = PROTO_STATE.get((c["state_label"] or "").lower(),
                                       (c["state_label"] or "").lower().replace(" ", "-"))
    c["tags"] = list(c["tags"] or [])
    c["contact_vip"] = bool(c["contact_vip"])   # no contact → False
    return c


def _vars(tpl, ctx):
    # first name = first word of the contact's name; same fallback as .name
    first = ((ctx["contact_name"] or "customer").split() or ["customer"])[0]
    return (tpl
            .replace("#{ticket.number}", str(ctx["id"]))
            .replace("#{ticket.title}", ctx["title"] or "")
            .replace("#{customer.first}", first)
            .replace("#{customer.name}", ctx["contact_name"] or "customer")
            .replace("#{client.name}", ctx["client_name"] or "")
            .replace("#{agent.name}", ctx["owner_name"] or "the team")
            .replace("#{state.label}", ctx["state_label"] or ""))


def _anyof(value):
    return [v.strip().lower() for v in str(value or "").split(",") if v.strip()]


# --------------------------------------------------------------------------
# mail rules — run on every inbound message, top to bottom
# --------------------------------------------------------------------------
def _mail_cond(cond, meta):
    hay = {
        "from": meta.get("from", ""),
        "fromDomain": (meta.get("from", "") or "").split("@")[-1] if "@" in (meta.get("from") or "") else "",
        "to": meta.get("to", ""),
        "subject": meta.get("subject", ""),
        "text": (meta.get("subject", "") or "") + " " + (meta.get("body", "") or ""),
    }.get(cond.get("field"), "") or ""
    vals = _anyof(cond.get("value"))
    h = hay.lower()
    if cond.get("op") == "is":
        return any(h == v for v in vals)
    return any(v in h for v in vals)


def apply_mail_rules(conn, ticket_id, meta):
    """Route/escalate/tag per the Rules table. Returns how many rules fired."""
    fired = 0
    with conn.cursor() as cur:
        rules = _rules(cur, "mail_rule")
        if not rules:
            return 0
        for r in rules:
            if not _match(r["conds"], lambda c: _mail_cond(c, meta)):
                continue
            act = r["actions"] if isinstance(r["actions"], dict) else \
                (r["actions"][0] if r["actions"] else {})
            ctx = _ctx(cur, ticket_id)
            if ctx is None:
                return fired
            did = []
            if act.get("groupId"):
                cur.execute("""UPDATE desk.tickets SET group_id = %s WHERE id = %s
                               AND EXISTS (SELECT 1 FROM shared.groups WHERE id = %s)""",
                            (act["groupId"], ticket_id, act["groupId"]))
                if cur.rowcount:
                    cur.execute("SELECT name FROM shared.groups WHERE id = %s", (act["groupId"],))
                    did.append(f"board → {cur.fetchone()[0]}")
            new_rank = None
            if act.get("prio"):
                new_rank = int(act["prio"])
            if act.get("prioAtLeast") and ctx["prio_rank"] < int(act["prioAtLeast"]):
                new_rank = int(act["prioAtLeast"])
            if new_rank and new_rank != ctx["prio_rank"]:
                cur.execute("""UPDATE desk.tickets t SET priority_id = p.id
                                 FROM desk.priorities p
                                WHERE t.id = %s AND p.rank = %s""", (ticket_id, new_rank))
                if cur.rowcount:
                    cur.execute("SELECT label FROM desk.priorities WHERE rank = %s", (new_rank,))
                    did.append(f"priority → {cur.fetchone()[0]}")
                    # priority triggers must see rule escalations too (audit:
                    # they fired only for UI changes)
                    enqueue(cur, "priority", ticket_id,
                            {"auto": meta.get("auto", False)}, 1)
            if act.get("tag") and act["tag"] not in ctx["tags"]:
                cur.execute("""INSERT INTO desk.ticket_tags (ticket_id, tag)
                               VALUES (%s, %s) ON CONFLICT DO NOTHING""",
                            (ticket_id, act["tag"]))
                did.append(f"tag “{act['tag']}”")
            if act.get("notify"):
                _notify(cur, "rule", f"Rule “{r['name']}” — #{ticket_id} {ctx['title'][:60]}",
                        ticket_id, group_id=ctx["group_id"])
                did.append("group notified")
            _bump_runs(cur, r["id"])
            if did:
                fired += 1
                line = " · ".join(did)
                _sys_article(cur, ticket_id, "Automation", f"⚙ Rule “{r['name']}” — {line}")
                _audit(cur, "Mail rule fired", ticket_id, f"#{ticket_id} · “{r['name']}” — {line}")
        if fired:
            cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s", (ticket_id,))
    return fired


# --------------------------------------------------------------------------
# ticket triggers
# --------------------------------------------------------------------------
def _trig_cond(cond, ctx, meta):
    hay = {
        "state": ctx["state_label"] or "",
        "priority": ctx["prio_label"] or "",
        "group": ctx["group_name"] or "",
        "client": ctx["client_name"] or "",
        "tags": ", ".join(ctx["tags"]),
        "from": meta.get("from", "") or "",
        "mailbox": meta.get("to") or ctx["inbound_to"] or "",
        "vip": "yes" if ctx["contact_vip"] else "no",
    }.get(cond.get("field"), "") or ""
    vals = _anyof(cond.get("value"))
    h = str(hay).lower()
    op = cond.get("op", "is")
    hit = (any(h == v for v in vals) if op in ("is", "is not")
           else any(v in h for v in vals))
    return (not hit) if op in ("is not", "not contains") else hit


def _autoassign(cur, ctx, mode):
    """rr = round-robin via desk.round_robin_cursors; least = fewest open."""
    cur.execute("""SELECT a.id, a.name FROM shared.agents a
                     JOIN shared.agent_groups ag ON ag.agent_id = a.id
                    WHERE ag.group_id = %s AND a.active ORDER BY a.name""",
                (ctx["group_id"],))
    pool = cur.fetchall()
    if not pool:
        return None
    if mode == "least":
        cur.execute("""SELECT t.owner_id, count(*) FROM desk.tickets t
                         JOIN desk.ticket_states s ON s.id = t.state_id
                        WHERE s.kind = 'open' AND t.owner_id = ANY(%s)
                        GROUP BY t.owner_id""", ([a[0] for a in pool],))
        loads = dict(cur.fetchall())
        pick = min(pool, key=lambda a: (loads.get(a[0], 0), a[1]))
        how = "least loaded"
    else:
        cur.execute("SELECT last_agent_id FROM desk.round_robin_cursors WHERE group_id = %s",
                    (ctx["group_id"],))
        row = cur.fetchone()
        ids = [a[0] for a in pool]
        nxt = (ids.index(row[0]) + 1) % len(ids) if row and row[0] in ids else 0
        pick = pool[nxt]
        cur.execute("""INSERT INTO desk.round_robin_cursors (group_id, last_agent_id)
                       VALUES (%s, %s)
                       ON CONFLICT (group_id) DO UPDATE SET last_agent_id = EXCLUDED.last_agent_id""",
                    (ctx["group_id"], pick[0]))
        how = "round-robin"
    cur.execute("UPDATE desk.tickets SET owner_id = %s WHERE id = %s", (pick[0], ctx["id"]))
    return pick[1], how


def _trigger_email(cur, ctx, body_tpl):
    """Same outbound resolution as agent replies — group_sendas override
    (when live + outbound) → fed-by mailbox, RECEIVE-ONLY accepted like the
    desk resolver (audit: requiring m.outbound here made trigger emails on
    receive-only boards vanish with no article and no audit trail — the desk
    path records 'RECORDED ONLY' instead). Returns a description or None
    (no recipient/mailbox at all)."""
    to = ctx["contact_email"] or ctx["last_sender"]
    if not to:
        return None
    cur.execute("""SELECT m.address, m.display_name, m.outbound
                     FROM desk.group_sendas gs
                     JOIN desk.mailboxes m ON m.id = gs.mailbox_id
                    WHERE gs.group_id = %s AND NOT m.paused AND m.outbound""",
                (ctx["group_id"],))
    mb = cur.fetchone()
    if mb is None:
        cur.execute("""SELECT m.address, m.display_name, m.outbound
                         FROM desk.mailboxes m
                        WHERE m.group_id = %s AND NOT m.paused
                        ORDER BY m.outbound DESC, m.address LIMIT 1""",
                    (ctx["group_id"],))
        mb = cur.fetchone()
    if mb is None:
        return None
    body = _vars(body_tpl, ctx)
    out_mid, sent, failed = None, False, False
    if mailer.outbound_enabled(cur) and mb[2]:
        cur.execute("""SELECT
                         (SELECT ar.message_id FROM desk.articles ar
                           WHERE ar.ticket_id = %s AND ar.message_id IS NOT NULL
                           ORDER BY ar.sent_at DESC LIMIT 1),
                         COALESCE((SELECT array_agg(ar.message_id ORDER BY ar.sent_at)
                           FROM desk.articles ar
                          WHERE ar.ticket_id = %s AND ar.message_id IS NOT NULL), '{}')""",
                    (ctx["id"], ctx["id"]))
        last_mid, all_mids = cur.fetchone()
        try:
            out_mid = mailer.send_reply(
                cur, mailbox_address=mb[0], display_name=mb[1] or "",
                to=to, subject=f"Service Ticket: [#{ctx['id']}] {ctx['title']}", body=body,
                in_reply_to=last_mid, references=list(all_mids or []))
            sent = True
        except mailer.MailError as exc:
            failed = True
            _audit(cur, "Trigger send failed", ctx["id"], str(exc)[:200])
    cur.execute("""INSERT INTO desk.articles
                     (ticket_id, kind, author, body, mail_from, mail_to,
                      message_id, is_auto)
                   VALUES (%s, 'reply', 'Docket · trigger', %s, %s, %s, %s, true)""",
                (ctx["id"], body, mb[0], to, out_mid))
    who = ctx["contact_name"] or to
    # three honest outcomes (audit: a FAILED send used to claim
    # 'outbound disabled' while the thread showed a delivered-looking reply)
    if sent:
        return f"emailed {who} from {mb[0].split('@')[0]}@"
    if failed:
        return f"reply to {who} recorded — SEND FAILED, not delivered (see audit log)"
    return (f"reply to {who} recorded ("
            + ("sender mailbox is receive-only" if not mb[2] else "outbound disabled") + ")")


def fire_triggers(conn, event, ticket_id, meta=None, depth=0):
    """Evaluate every enabled trigger for one event on one ticket."""
    meta = meta or {}
    fired = 0
    with conn.cursor() as cur:
        trigs = [t for t in _rules(cur, "trigger") if t["event"] == event]
        if not trigs:
            return 0
        for g in trigs:
            ctx = _ctx(cur, ticket_id)
            if ctx is None:
                return fired
            if event == "state" and g["event_value"] and g["event_value"] != ctx["proto_state"]:
                continue
            if not _match(g["conds"], lambda c: _trig_cond(c, ctx, meta)):
                continue
            did = []
            for a in (g["actions"] if isinstance(g["actions"], list) else []):
                typ, val = a.get("type"), a.get("value")
                if typ == "email":
                    if meta.get("auto"):
                        continue          # loop guard: never auto-reply to auto mail
                    d = _trigger_email(cur, ctx, str(val or ""))
                    if d:
                        did.append(d)
                elif typ == "note":
                    _sys_note = _vars(str(val or ""), ctx)
                    cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, body, is_auto)
                                   VALUES (%s, 'note', 'Docket · trigger', %s, true)""",
                                (ticket_id, _sys_note))
                    did.append("internal note added")
                elif typ == "tag" and val and val not in ctx["tags"]:
                    cur.execute("""INSERT INTO desk.ticket_tags (ticket_id, tag)
                                   VALUES (%s, %s) ON CONFLICT DO NOTHING""", (ticket_id, val))
                    did.append(f"tag “{val}”")
                elif typ == "state" and val:
                    label = {v: k for k, v in PROTO_STATE.items()}.get(str(val))
                    if label and label != (ctx["state_label"] or "").lower():
                        # NOT is_system + active, same as the custom branch:
                        # mapping child-closed for EVENT matching must not let
                        # an ACTION drive the cascade-only system state. Done
                        # states clear the wake timer like every close path.
                        cur.execute("""UPDATE desk.tickets t
                                          SET state_id = s.id,
                                              pending_until = CASE WHEN s.kind = 'done'
                                                              THEN NULL ELSE t.pending_until END
                                         FROM desk.ticket_states s
                                        WHERE t.id = %s AND lower(s.label) = %s
                                          AND s.active AND NOT s.is_system
                                        RETURNING s.label""",
                                    (ticket_id, label))
                        row = cur.fetchone()
                        if row:
                            did.append(f"state → {row[0]}")
                            enqueue(cur, "state", ticket_id, {"auto": meta.get("auto", False)},
                                    depth + 1)
                    elif not label:
                        # CUSTOM state: the builder saved the bootstrap's
                        # derived slug (label.lower(), spaces → '-') — resolve
                        # it the same way instead of silently dropping the
                        # action (audit). System states stay engine-only via
                        # the cascade, never a trigger target.
                        cur.execute("""UPDATE desk.tickets t
                                          SET state_id = s.id,
                                              pending_until = CASE WHEN s.kind = 'done'
                                                              THEN NULL ELSE t.pending_until END
                                         FROM desk.ticket_states s
                                        WHERE t.id = %s AND s.active AND NOT s.is_system
                                          AND replace(lower(s.label), ' ', '-') = %s
                                          AND t.state_id <> s.id
                                        RETURNING s.label""",
                                    (ticket_id, str(val)))
                        row = cur.fetchone()
                        if row:
                            did.append(f"state → {row[0]}")
                            enqueue(cur, "state", ticket_id, {"auto": meta.get("auto", False)},
                                    depth + 1)
                elif typ == "prio" and val:
                    if int(val) != ctx["prio_rank"]:
                        cur.execute("""UPDATE desk.tickets t SET priority_id = p.id
                                         FROM desk.priorities p
                                        WHERE t.id = %s AND p.rank = %s
                                        RETURNING p.label""",
                                    (ticket_id, int(val)))
                        row = cur.fetchone()
                        if row:
                            did.append(f"priority → {row[0]}")
                            enqueue(cur, "priority", ticket_id, {"auto": meta.get("auto", False)},
                                    depth + 1)
                elif typ == "group" and val:
                    if str(val) != str(ctx["group_id"]):
                        cur.execute("""UPDATE desk.tickets SET group_id = %s WHERE id = %s
                                       AND EXISTS (SELECT 1 FROM shared.groups WHERE id = %s)""",
                                    (val, ticket_id, val))
                        if cur.rowcount:
                            did.append("board moved")
                elif typ == "autoassign" and not ctx["owner_id"]:
                    pick = _autoassign(cur, ctx, "least" if val == "least" else "rr")
                    if pick:
                        did.append(f"assigned → {pick[0].split(' ')[0]} ({pick[1]})")
                        enqueue(cur, "owner", ticket_id, {"auto": meta.get("auto", False)},
                                depth + 1)
            _bump_runs(cur, g["id"])
            if did:
                fired += 1
                line = " · ".join(did)
                _sys_article(cur, ticket_id, "Trigger", f"⚡ Trigger “{g['name']}” — {line}")
                _audit(cur, "Trigger fired", ticket_id, f"#{ticket_id} · “{g['name']}” — {line}")
        if fired:
            cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s", (ticket_id,))
    return fired


def process_events(conn) -> int:
    """Drain the outbox — SKIP LOCKED so a second worker can never
    double-fire; each event is marked processed whatever happens."""
    with conn.cursor() as cur:
        cur.execute("""SELECT id, event, ticket_id, meta, depth
                         FROM desk.automation_events
                        WHERE processed_at IS NULL
                        ORDER BY id LIMIT 50
                          FOR UPDATE SKIP LOCKED""")
        events = cur.fetchall()
        if not events:
            return 0
        cur.execute("UPDATE desk.automation_events SET processed_at = now() "
                    "WHERE id = ANY(%s)", ([e[0] for e in events],))
    for _id, event, ticket_id, meta, depth in events:
        # savepoint per EVENT (audit): a SQL error mid-trigger used to leave
        # the shared tx aborted — every later event failed, the worker's
        # rollback then RESET processed_at on events whose emails had already
        # gone out, and the next pass re-mailed customers every 30s. Fenced,
        # the poison event's work rolls back alone and its processed_at
        # marking (written above, before this loop) survives the commit.
        with conn.cursor() as cur:
            cur.execute("SAVEPOINT evt")
        try:
            fire_triggers(conn, event, ticket_id, _jload(meta) or {}, depth or 0)
            with conn.cursor() as cur:
                cur.execute("RELEASE SAVEPOINT evt")
        except Exception as exc:
            with conn.cursor() as cur:
                cur.execute("ROLLBACK TO SAVEPOINT evt")
            print(f"trigger evaluation failed for event {_id} (#{ticket_id}): {exc}")
    return len(events)


# --------------------------------------------------------------------------
# SLA — business-hours walk + one-shot warn/breach fan-out
# --------------------------------------------------------------------------
def _add_biz_hours(start, hours, biz, tz):
    """15-minute-step walk inside working time — same algorithm and 40k-step
    guard as the prototype's addBizHours, in the shop's timezone."""
    days = set(_daynums(biz.get("days")))
    h0 = _hournum(biz.get("start"), 8)
    h1 = _hournum(biz.get("end"), 18)
    if h1 <= h0:
        h1 = h0 + 1
    holidays = set(biz.get("holidays", []))
    remaining = hours * 60.0
    t = start.astimezone(tz)
    step = timedelta(minutes=15)
    guard = 0
    while remaining > 0 and guard < 40000:
        guard += 1
        # python weekday(): Mon=0; prototype getDay(): Sun=0 — convert
        dow = (t.weekday() + 1) % 7
        in_biz = (dow in days and t.strftime("%Y-%m-%d") not in holidays
                  and h0 <= (t.hour + t.minute / 60.0) < h1)
        if in_biz:
            remaining -= 15
        t += step
    return t


def sla_pass(conn) -> int:
    """Warn (due inside 2h) and breach notices for open tickets, once each per
    clock. Fan-out = desk.notifications targeted at the ticket's board, plus
    the owner directly when there is one, plus an audit line — the bell (and
    later email/Teams) hydrate from the same table."""
    with conn.cursor() as cur:
        sla = _config(cur, "sla", {})
        if not sla:
            return 0
        biz = _config(cur, "business_hours", {})
        try:
            tz = ZoneInfo(biz.get("tz", "America/New_York"))
        except Exception:                       # missing tzdb — degrade, don't die
            from datetime import timezone
            tz = timezone.utc
        cur.execute("""
            SELECT t.id, t.title, t.created_at, t.group_id, t.owner_id, p.rank,
                   EXISTS (SELECT 1 FROM desk.articles ar
                            WHERE ar.ticket_id = t.id AND ar.kind = 'reply'
                              AND NOT ar.is_auto) AS fr_met
              FROM desk.tickets t
              JOIN desk.ticket_states s ON s.id = t.state_id
              JOIN desk.priorities p ON p.id = t.priority_id
             WHERE s.kind = 'open' AND t.merged_into_id IS NULL""")
        rows = cur.fetchall()
        now = datetime.now(tz)
        hit = 0
        for tid, title, created, group_id, owner_id, rank, fr_met in rows:
            pol = sla.get(str(rank))
            if not isinstance(pol, dict):
                continue
            kind = "res" if fr_met else "fr"
            label = "resolution" if fr_met else "first response"
            hours = pol.get("res" if fr_met else "fr")
            if not hours:
                continue
            due = _add_biz_hours(created, float(hours), biz, tz)
            stage = None
            if now > due:
                stage = "breach"
            elif due - now < timedelta(hours=2):
                stage = "warn"
            if stage is None:
                continue
            cur.execute("""INSERT INTO desk.sla_notices (ticket_id, kind, stage)
                           VALUES (%s, %s, %s) ON CONFLICT DO NOTHING""",
                        (tid, kind, stage))
            if not cur.rowcount:
                continue                      # already told them
            hit += 1
            t40 = (title or "")[:40]
            if stage == "breach":
                text = f"SLA BREACHED — #{tid} {t40} · {label} overdue"
            else:
                mins = max(1, int((due - now).total_seconds() // 60))
                text = f"SLA due soon — #{tid} {t40} · {label} in {mins} min"
            _notify(cur, stage, text, tid, group_id=group_id)
            if owner_id:
                _notify(cur, stage, text, tid, agent_id=owner_id)
            _audit(cur, "SLA " + ("breached" if stage == "breach" else "warning"),
                   tid, text)
        return hit
