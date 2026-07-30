"""Automations — CRUD for the Rules and Triggers builders, plus the bell.

The builders own the jsonb shapes (see mail-worker/app/automations.py for the
vocabulary contract); this router just validates the envelope and persists.
Deletion is archive-first per convention — the runs history survives.
"""
import json
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from pydantic import BaseModel

from . import auth, db

router = APIRouter(prefix="/api/automations")

EVENTS = ("create", "followup", "state", "priority", "owner")


class NewRule(BaseModel):
    kind: str                          # mail_rule | trigger
    name: str
    event: str | None = None           # triggers only
    event_value: str = ""              # "…to state" for state triggers
    conditions: list = []
    actions: dict | list = {}          # mail_rule: object; trigger: list
    enabled: bool = True


class PatchRule(BaseModel):
    name: str | None = None
    event: str | None = None
    event_value: str | None = None
    conditions: list | None = None
    actions: dict | list | None = None
    enabled: bool | None = None
    archived: bool | None = None


def _check(kind, event):
    if kind not in ("mail_rule", "trigger"):
        raise HTTPException(422, "kind must be mail_rule or trigger")
    if kind == "trigger" and event not in EVENTS:
        raise HTTPException(422, f"trigger event must be one of {', '.join(EVENTS)}")


@router.post("/rules", status_code=201)
def create_rule(body: NewRule, request: Request):
    _check(body.kind, body.event)
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_automations")
        with conn.cursor() as cur:
            cur.execute("""SELECT COALESCE(max(position), 0) + 1
                             FROM desk.automation_rules WHERE kind = %s""", (body.kind,))
            (pos,) = cur.fetchone()
            cur.execute("""INSERT INTO desk.automation_rules
                             (name, kind, event, event_value, enabled,
                              conditions, actions, position)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                           RETURNING id""",
                        (body.name, body.kind,
                         body.event if body.kind == "trigger" else None,
                         body.event_value or "", body.enabled,
                         json.dumps(body.conditions), json.dumps(body.actions), pos))
            (rid,) = cur.fetchone()
        auth.audit(conn, "desk",
                   "Rule created" if body.kind == "mail_rule" else "Trigger created",
                   f"rule:{rid}", f"{body.name} · by {who['label']}")
        return {"id": str(rid)}


@router.patch("/rules/{rule_id}")
def patch_rule(rule_id: str, body: PatchRule, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_automations")
        with conn.cursor() as cur:
            cur.execute("SELECT name, kind FROM desk.automation_rules WHERE id = %s",
                        (rule_id,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such rule")
            name0, kind = row
            if body.event is not None and kind == "trigger" and body.event not in EVENTS:
                raise HTTPException(422, f"event must be one of {', '.join(EVENTS)}")
            sets, args, notes = [], [], []
            for col, val, enc in (("name", body.name, None),
                                  ("event", body.event, None),
                                  ("event_value", body.event_value, None),
                                  ("conditions", body.conditions, json.dumps),
                                  ("actions", body.actions, json.dumps),
                                  ("enabled", body.enabled, None),
                                  ("archived", body.archived, None)):
                if val is None:
                    continue
                sets.append(f"{col} = %s")
                args.append(enc(val) if enc else val)
                notes.append(col if enc else f"{col}={val}" if isinstance(val, (bool,)) else col)
            if not sets:
                return {"ok": True}
            cur.execute(f"UPDATE desk.automation_rules SET {', '.join(sets)}, "
                        "version = version + 1 WHERE id = %s", (*args, rule_id))
        label = "Rule" if kind == "mail_rule" else "Trigger"
        action = (f"{label} archived" if body.archived
                  else f"{label} updated")
        auth.audit(conn, "desk", action, f"rule:{rule_id}",
                   f"{body.name or name0} · " + ", ".join(notes))
        return {"ok": True}


class RuleOrder(BaseModel):
    ids: list[str]                     # full desired order, first runs first


@router.post("/rules/order")
def order_rules(body: RuleOrder, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_automations")
        with conn.cursor() as cur:
            for i, rid in enumerate(body.ids, start=1):
                cur.execute("UPDATE desk.automation_rules SET position = %s WHERE id = %s",
                            (i, rid))
        auth.audit(conn, "desk", "Rules reordered", None,
                   f"{len(body.ids)} rules · by {who['label']}")
        return {"ok": True}


# --- the bell --------------------------------------------------------------
def _notifs(cur, who, limit=50):
    cur.execute("""
        SELECT n.id, n.kind, n.body, n.ticket_id, n.created_at, n.read_at
          FROM desk.notifications n
         WHERE (n.agent_id = %(me)s
                OR (n.agent_id IS NULL AND n.group_id IS NULL)
                OR n.group_id IN (SELECT group_id FROM shared.agent_groups
                                   WHERE agent_id = %(me)s))
         ORDER BY n.created_at DESC LIMIT %(limit)s""",
        {"me": who["agent_id"], "limit": limit})
    ms = lambda dt: int(dt.timestamp() * 1000) if dt else None
    return [{"id": str(r[0]), "kind": r[1], "text": r[2], "ticketId": r[3],
             "ts": ms(r[4]), "read": r[5] is not None} for r in cur.fetchall()]


@router.get("/notifications")
def notifications(request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        with conn.cursor() as cur:
            return {"notifs": _notifs(cur, who)}


class MarkRead(BaseModel):
    ids: list[str]


@router.post("/notifications/read")
def mark_read(body: MarkRead, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        with conn.cursor() as cur:
            cur.execute("""UPDATE desk.notifications SET read_at = now()
                            WHERE id = ANY(%s::uuid[]) AND read_at IS NULL""",
                        (body.ids,))
        return {"ok": True}
