"""Ticket surface. Reads mirror window.DocketAPI; writes cover the working
loop: props (optimistic-locked), tags, pending wakes, and transactional merge
(HANDOFF §10.11). Locked projects refuse everything (423)."""
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from psycopg import errors as pg_errors
from pydantic import BaseModel
from . import auth, automations, db, helpers, mailer

router = APIRouter(prefix="/api")

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


@router.get("/tickets")
def list_tickets(request: Request, state: str | None = None, client: str | None = None,
                 limit: int = 100):
    with db.connect() as conn:
        auth.require(conn, request)
        where, args = [], []
        if state:
            where.append("(lower(s.label) = lower(%s) OR s.kind = lower(%s))")
            args += [state, state]
        if client:
            where.append("(c.name = %s OR c.id::text = %s)")
            args += [client, client]
        sql = TICKET_SELECT + (" WHERE " + " AND ".join(where) if where else "")
        sql += " ORDER BY t.updated_at DESC LIMIT %s"
        args.append(min(limit, 500))
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, args)
            return {"tickets": cur.fetchall()}


@router.get("/tickets/{ticket_id}")
def get_ticket(ticket_id: int, request: Request):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(TICKET_SELECT + " WHERE t.id = %s", (ticket_id,))
            ticket = cur.fetchone()
            if ticket is None:
                raise HTTPException(404, "No such ticket")
            cur.execute(
                """SELECT id, kind, author, mail_from, mail_to, mail_cc,
                          body, is_auto, sent_at,
                          (SELECT count(*) FROM desk.attachments at
                            WHERE at.article_id = ar.id) AS attachments
                     FROM desk.articles ar
                    WHERE ar.ticket_id = %s ORDER BY sent_at""", (ticket_id,))
            ticket["articles"] = cur.fetchall()
            cur.execute(
                """SELECT e.id, e.started_at, e.ended_at, e.hours,
                          a.name AS technician, at.name AS activity_type,
                          e.task_id, e.status,
                          e.submitted_at IS NOT NULL AS submitted,
                          e.ts_approved_at IS NOT NULL AS ts_approved
                     FROM ledger.time_entries e
                     JOIN shared.agents a ON a.id = e.tech_id
                     JOIN ledger.activity_types at ON at.id = e.activity_type_id
                    WHERE e.ticket_id = %s ORDER BY e.started_at""", (ticket_id,))
            ticket["time"] = cur.fetchall()
            if ticket["is_project"]:
                cur.execute(
                    """SELECT status, billing_model, project_flat_cents, unlocked, approved_at
                         FROM desk.projects WHERE ticket_id = %s""", (ticket_id,))
                ticket["project"] = cur.fetchone() or {}
                cur.execute(
                    """SELECT id, label, position, done_at IS NOT NULL AS done,
                              billing_mode, rate_cents, flat_cents
                         FROM desk.project_tasks WHERE ticket_id = %s ORDER BY position""",
                    (ticket_id,))
                ticket["project"]["tasks"] = cur.fetchall()
            return ticket


@router.get("/reports/queue")
def report_queue(request: Request):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor(row_factory=dict_row) as cur:
            out = {}
            for name, col in (("by_state", "s.kind"), ("by_group", "g.name"),
                              ("by_priority", "p.label")):
                cur.execute(f"""
                    SELECT {col} AS key, count(*) AS n
                      FROM desk.tickets t
                      JOIN desk.ticket_states s ON s.id = t.state_id
                      JOIN desk.priorities p    ON p.id = t.priority_id
                      JOIN shared.groups g      ON g.id = t.group_id
                     WHERE s.kind <> 'done'
                     GROUP BY 1 ORDER BY n DESC""")
                out[name] = cur.fetchall()
            return out


@router.get("/audit")
def get_audit(request: Request, limit: int = 100):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'view_audit')
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""SELECT at, actor, app, action, entity, detail
                             FROM audit.events ORDER BY at DESC LIMIT %s""",
                        (min(limit, 1000),))
            return {"events": cur.fetchall()}


ST_MAP = {"new": "new", "open": "open", "pending reminder": "pending",
          "on hold": "hold", "solved": "solved", "closed": "closed",
          "archived": "archived"}


def emit_event(cur, event: str, ticket_id: int):
    """Feed the automations outbox — the mail-worker's engine evaluates
    triggers within one scheduler pass. Manual/API mutations are never
    auto-generated mail, so meta.auto is false (email actions may run)."""
    cur.execute("""INSERT INTO desk.automation_events (event, ticket_id, meta)
                   VALUES (%s, %s, '{"auto": false}')""", (event, ticket_id))


@router.get("/bootstrap")
def bootstrap(request: Request, limit: int = 500):
    """The whole app state, shaped exactly like the prototype's in-page state
    so DESK-LIVE hydrates without translation at the UI layer."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        ms = lambda dt: int(dt.timestamp() * 1000) if dt else None
        out = {"me": {"id": str(who["agent_id"]), "name": who["name"],
                      "email": who["email"], "perms": sorted(who["perms"]),
                      "initials": "".join(w[0] for w in who["name"].split()[:2]).upper()}}
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT id, name FROM shared.groups WHERE active ORDER BY name")
            out["groups"] = [{"id": str(r["id"]), "name": r["name"]} for r in cur.fetchall()]
            cur.execute("""SELECT a.id, a.name, a.initials, a.email, r.name AS role,
                             COALESCE((SELECT array_agg(ag.group_id) FROM shared.agent_groups ag
                                        WHERE ag.agent_id = a.id), '{}') AS gids
                             FROM shared.agents a LEFT JOIN shared.roles r ON r.id = a.role_id
                            WHERE a.active ORDER BY a.name""")
            out["agents"] = [{"id": str(r["id"]), "name": r["name"], "initials": r["initials"],
                             "email": r["email"], "role": r["role"] or "Technician",
                             "groups": [str(g) for g in r["gids"]]} for r in cur.fetchall()]
            cur.execute("""SELECT c.id, c.name, c.is_sentinel, c.archived_at, c.profile,
                             COALESCE((SELECT array_agg(domain) FROM shared.client_domains d
                                        WHERE d.client_id = c.id), '{}') AS domains
                             FROM shared.clients c ORDER BY c.is_sentinel DESC, c.name""")
            clients = {}
            for r in cur.fetchall():
                prof = r["profile"] if isinstance(r["profile"], dict) else {}
                doms = list(r["domains"])
                clients[str(r["id"])] = {
                    "id": str(r["id"]), "name": r["name"], "sentinel": r["is_sentinel"],
                    "archived": r["archived_at"] is not None,
                    "status": "archived" if r["archived_at"] is not None else "active",
                    "domain": doms[0] if doms else "", "domains": doms,
                    **{k: prof.get(k, "") for k in
                       ("industry", "website", "phone", "fax", "addr1", "addr2",
                        "city", "st", "zip", "tz", "since", "notes")},
                    "contacts": []}
            cur.execute("""SELECT id, client_id, name, email, title, department, phone,
                             mobile, active
                             FROM shared.contacts ORDER BY name""")
            for r in cur.fetchall():
                c = clients.get(str(r["client_id"]))
                if c is not None:
                    c["contacts"].append({"id": str(r["id"]), "name": r["name"],
                                          "email": r["email"], "title": r["title"],
                                          "dept": r["department"], "phone": r["phone"],
                                          "mobile": r["mobile"], "active": r["active"]})
            out["clients"] = list(clients.values())
            cur.execute("SELECT id, name, billable, active FROM ledger.activity_types ORDER BY is_sentinel DESC, name")
            # archived types ride along (active:false) so existing time chips
            # still resolve a name; the composer picker filters via aATYPES()
            out["atypes"] = [{"id": str(r["id"]), "name": r["name"], "billable": r["billable"],
                              "active": r["active"]}
                             for r in cur.fetchall()]
            cur.execute("SELECT label, kind FROM desk.ticket_states WHERE active ORDER BY position")
            out["states"] = [{"id": ST_MAP.get(r["label"].lower(),
                                               r["label"].lower().replace(" ", "-")),
                              "label": r["label"], "type": r["kind"]} for r in cur.fetchall()]
            cur.execute("""SELECT id, name, body FROM desk.canned_responses
                            WHERE active ORDER BY name""")
            out["canned"] = [{"id": str(r["id"]), "name": r["name"], "body": r["body"]}
                             for r in cur.fetchall()]
            cur.execute("""SELECT key, value, updated_at, updated_by FROM shared.app_config
                            WHERE key IN ('graph','auth','verification')""")
            cfgs = {r["key"]: r for r in cur.fetchall()}
            g = cfgs.get("graph", {"value": {}, "updated_at": None, "updated_by": ""})
            gv = g["value"] if isinstance(g["value"], dict) else {}
            out["graph"] = {"tenant": gv.get("tenant", ""), "clientId": gv.get("client_id", ""),
                            "connected": bool(gv.get("connected")),
                            "at": ms(g.get("updated_at")), "by": g.get("updated_by") or ""}
            v = cfgs.get("verification", {"value": {}})
            out["vcfg"] = v["value"] if isinstance(v["value"], dict) else {}
            a = cfgs.get("auth", {"value": {}})
            av = a["value"] if isinstance(a["value"], dict) else {}
            out["authCfg"] = {"ssoConnected": bool(av.get("sso_enabled")),
                              "tenant": av.get("tenant", "") or gv.get("tenant", ""),
                              "clientId": av.get("client_id", "") or gv.get("client_id", ""),
                              "redirectUri": av.get("redirect_uri", ""),
                              "localPasswords": bool(av.get("local_passwords", True)),
                              "roleMapping": bool(av.get("role_mapping")),
                              "mfa": av.get("mfa", "optional")}
            cur.execute("SELECT name, rotated_at, rotated_by FROM shared.secrets")
            out["secretMeta"] = {r["name"]: {"at": ms(r["rotated_at"]),
                                             "by": r["rotated_by"]} for r in cur.fetchall()}
            cur.execute("SELECT value FROM shared.app_config WHERE key = 'mail'")
            row = cur.fetchone()
            mail_cfg = row["value"] if row else {}
            outbound = bool((mail_cfg or {}).get("outbound_enabled"))
            cur.execute("""SELECT m.id, m.address, m.display_name, m.group_id, m.paused,
                             COALESCE(p.rank, 2) AS prio,
                             (SELECT count(*) FROM desk.articles ar
                               WHERE ar.mail_to = m.address AND ar.kind = 'mail_in'
                                 AND ar.sent_at::date = current_date) AS today
                             FROM desk.mailboxes m
                             LEFT JOIN desk.priorities p ON p.id = m.default_priority_id
                            ORDER BY m.address""")
            out["mailboxes"] = [{"id": str(r["id"]), "addr": r["address"],
                                 "type": "shared", "groupId": str(r["group_id"]),
                                 "prio": r["prio"], "outbound": outbound,
                                 "desc": r["display_name"] or "",
                                 "status": "paused" if r["paused"] else "connected",
                                 "today": r["today"]} for r in cur.fetchall()]
            cur.execute("""SELECT r.name, r.note, r.is_core, r.entra_group,
                             COALESCE((SELECT array_agg(permission_id)
                                        FROM shared.role_permissions rp
                                       WHERE rp.role_id = r.id), '{}') AS perms
                             FROM shared.roles r WHERE r.active ORDER BY r.name""")
            out["roles"] = [{"name": r["name"], "note": r["note"], "core": r["is_core"],
                             "entra": r["entra_group"] or "",
                             "perms": list(r["perms"])} for r in cur.fetchall()]
            # automations — emitted in the prototype's own vocabulary so the
            # builders hydrate without translation (bug #22's lesson)
            cur.execute("""SELECT id, name, kind, event, event_value, enabled,
                                  conditions, actions, runs
                             FROM desk.automation_rules WHERE NOT archived
                            ORDER BY position, created_at""")
            mail_rules, triggers = [], []
            for r in cur.fetchall():
                conds = r["conditions"] if isinstance(r["conditions"], list) else []
                acts = r["actions"]
                base = {"id": str(r["id"]), "name": r["name"], "enabled": r["enabled"],
                        "runs": r["runs"], "conds": conds}
                if r["kind"] == "mail_rule":
                    base["act"] = acts if isinstance(acts, dict) else (acts[0] if acts else {})
                    mail_rules.append(base)
                else:
                    base.update({"event": r["event"], "eventValue": r["event_value"] or "",
                                 "actions": acts if isinstance(acts, list) else []})
                    triggers.append(base)
            out["rules"] = {"mail": mail_rules, "triggers": triggers}
            cur.execute("""SELECT key, value FROM shared.app_config
                            WHERE key IN ('sla', 'business_hours')""")
            eng = {r["key"]: (r["value"] if isinstance(r["value"], dict) else {})
                   for r in cur.fetchall()}
            out["sla"] = eng.get("sla", {})
            out["biz"] = eng.get("business_hours", {})
            cur.execute("""SELECT t.id, t.title, t.client_id, t.contact_id, t.group_id,
                             t.owner_id, s.label AS st_label, p.rank AS prio,
                             t.pending_until, t.merged_into_id, t.is_project, t.cc,
                             t.created_at, t.updated_at, t.version,
                             EXISTS (SELECT 1 FROM desk.articles fr
                                      WHERE fr.ticket_id = t.id AND fr.kind = 'reply'
                                        AND NOT fr.is_auto) AS fr_met,
                             COALESCE((SELECT array_agg(tag ORDER BY tag)
                                        FROM desk.ticket_tags tt WHERE tt.ticket_id = t.id), '{}') AS tags
                             FROM desk.tickets t
                             JOIN desk.ticket_states s ON s.id = t.state_id
                             JOIN desk.priorities p ON p.id = t.priority_id
                            ORDER BY t.updated_at DESC LIMIT %s""", (limit,))
            tickets = {}
            for r in cur.fetchall():
                tickets[r["id"]] = {
                    "id": r["id"], "title": r["title"],
                    "clientId": str(r["client_id"]),
                    "contactId": str(r["contact_id"]) if r["contact_id"] else None,
                    "groupId": str(r["group_id"]),
                    "ownerId": str(r["owner_id"]) if r["owner_id"] else None,
                    "st": ST_MAP.get(r["st_label"].lower(),
                                     r["st_label"].lower().replace(" ", "-")),
                    "prio": r["prio"], "tags": list(r["tags"]), "cc": list(r["cc"] or []),
                    "pendingUntil": ms(r["pending_until"]),
                    "mergedInto": r["merged_into_id"], "isProject": r["is_project"],
                    "createdAt": ms(r["created_at"]), "updatedAt": ms(r["updated_at"]),
                    "slaFrMet": r["fr_met"],
                    "version": r["version"], "articles": [], "time": []}
            if tickets:
                ids = list(tickets)
                cur.execute("""SELECT ticket_id, id, kind, author, body, body_html,
                                 is_auto, mail_from, mail_to, sent_at
                                 FROM desk.articles WHERE ticket_id = ANY(%s)
                                ORDER BY sent_at""", (ids,))
                for r in cur.fetchall():
                    tickets[r["ticket_id"]]["articles"].append({
                        "id": str(r["id"]),
                        "kind": "mail-in" if r["kind"] == "mail_in" else r["kind"],
                        "author": {"name": r["author"]}, "ts": ms(r["sent_at"]),
                        "body": r["body"], "bodyHtml": r["body_html"],
                        "auto": r["is_auto"],
                        "mailFrom": r["mail_from"], "mailTo": r["mail_to"]})
                cur.execute("""SELECT e.ticket_id, e.id, e.tech_id, e.activity_type_id,
                                 e.task_id, e.hours, e.started_at, e.ended_at, e.status,
                                 e.submitted_at, e.ts_approved_at, e.article_id, e.version
                                 FROM ledger.time_entries e
                                WHERE e.ticket_id = ANY(%s) AND e.status <> 'void'
                                ORDER BY e.started_at""", (ids,))
                for r in cur.fetchall():
                    tickets[r["ticket_id"]]["time"].append({
                        "eid": str(r["id"]), "techId": str(r["tech_id"]),
                        "typeId": str(r["activity_type_id"]),
                        "taskId": str(r["task_id"]) if r["task_id"] else None,
                        "h": float(r["hours"]),
                        "startedAt": ms(r["started_at"]), "endedAt": ms(r["ended_at"]),
                        "void": r["status"] == "void",
                        "submitted": r["submitted_at"] is not None,
                        "approved": r["ts_approved_at"] is not None,
                        "articleId": str(r["article_id"]) if r["article_id"] else None,
                        "version": r["version"]})
                cur.execute("""SELECT p.ticket_id, p.status, p.billing_model,
                                 p.project_flat_cents, p.template, p.unlocked,
                                 p.submitted_at, p.approved_at
                                 FROM desk.projects p WHERE p.ticket_id = ANY(%s)""", (ids,))
                for r in cur.fetchall():
                    tickets[r["ticket_id"]]["project"] = {
                        "status": r["status"],
                        "pmode": "flat" if r["billing_model"] == "project_flat" else "tasks",
                        "projectFlat": (r["project_flat_cents"] or 0) / 100 or None,
                        "template": r["template"], "unlocked": r["unlocked"],
                        "defaultMode": "hourly",
                        "submittedAt": ms(r["submitted_at"]),
                        "approvedAt": ms(r["approved_at"]), "tasks": []}
                cur.execute("""SELECT pt.ticket_id, pt.id, pt.label, pt.position,
                                 pt.done_at, pt.done_by, pt.billing_mode,
                                 pt.rate_cents, pt.flat_cents
                                 FROM desk.project_tasks pt WHERE pt.ticket_id = ANY(%s)
                                ORDER BY pt.position""", (ids,))
                for r in cur.fetchall():
                    proj = tickets[r["ticket_id"]].get("project")
                    if proj is not None:
                        proj["tasks"].append({
                            "id": str(r["id"]), "label": r["label"],
                            "done": r["done_at"] is not None, "doneAt": ms(r["done_at"]),
                            "doneBy": str(r["done_by"]) if r["done_by"] else None,
                            "mode": r["billing_mode"],
                            "rate": (r["rate_cents"] / 100) if r["rate_cents"] is not None else None,
                            "flat": (r["flat_cents"] / 100) if r["flat_cents"] is not None else None})
            out["tickets"] = list(tickets.values())
            cur.execute("""SELECT at, actor, action, detail FROM audit.events
                            ORDER BY at DESC LIMIT 120""")
            out["audit"] = [{"ts": ms(r["at"]), "who": r["actor"], "action": r["action"],
                             "detail": r["detail"] or ""} for r in cur.fetchall()]
        with conn.cursor() as plain:
            out["notifs"] = automations._notifs(plain, who)
        return out


@router.get("/meta")
def meta(request: Request):
    """Everything the UI needs for selects, in one call."""
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor(row_factory=dict_row) as cur:
            out = {}
            cur.execute("SELECT label, kind FROM desk.ticket_states WHERE active ORDER BY position")
            out["states"] = cur.fetchall()
            cur.execute("SELECT label FROM desk.priorities WHERE active ORDER BY rank")
            out["priorities"] = [r["label"] for r in cur.fetchall()]
            cur.execute("SELECT name FROM shared.groups WHERE active ORDER BY name")
            out["groups"] = [r["name"] for r in cur.fetchall()]
            cur.execute("SELECT name, email FROM shared.agents WHERE active ORDER BY name")
            out["agents"] = cur.fetchall()
            cur.execute("SELECT name FROM ledger.activity_types WHERE active AND NOT is_sentinel ORDER BY name")
            out["activity_types"] = [r["name"] for r in cur.fetchall()]
            return out


class NewTicket(BaseModel):
    title: str
    client: str
    group: str
    contact_email: str | None = None
    priority: str = "Normal"


@router.post("/tickets", status_code=201)
def create_ticket(body: NewTicket, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'create')
        with conn.cursor() as cur:
            client_id = helpers.client_id(cur, body.client)
            group_id = helpers.group_id(cur, body.group)
            priority = helpers.priority_id(cur, body.priority)
            contact_id = None
            if body.contact_email:
                cur.execute("SELECT id FROM shared.contacts WHERE lower(email) = lower(%s)",
                            (body.contact_email,))
                row = cur.fetchone()
                contact_id = row[0] if row else None
            cur.execute(
                """INSERT INTO desk.tickets
                     (title, client_id, contact_id, group_id, state_id, priority_id)
                   VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
                (body.title, client_id, contact_id, group_id,
                 helpers.state_id(cur, "New"), priority))
            (ticket_id,) = cur.fetchone()
            emit_event(cur, "create", ticket_id)
        auth.audit(conn, "desk", "Ticket created", f"ticket:{ticket_id}",
                   f"#{ticket_id} {body.title} — via API ({who['label']})")
        return {"id": ticket_id}


class PatchTicket(BaseModel):
    version: int                       # optimistic lock — from your last read
    title: str | None = None
    state: str | None = None
    contact: str | None = None         # contact uuid or email; "" clears
    priority: str | None = None
    owner_email: str | None = None     # "" clears the owner
    group: str | None = None
    pending_until: str | None = None   # ISO; "" clears


@router.patch("/tickets/{ticket_id}")
def patch_ticket(ticket_id: int, body: PatchTicket, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'edit_props', 'assign', 'close')
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            sets, args, notes = [], [], []
            if body.title is not None:
                sets.append("title = %s"); args.append(body.title); notes.append("title")
            if body.state is not None:
                sets.append("state_id = %s"); args.append(helpers.state_id(cur, body.state))
                notes.append(f"state → {body.state}")
            if body.priority is not None:
                sets.append("priority_id = %s"); args.append(helpers.priority_id(cur, body.priority))
                notes.append(f"priority → {body.priority}")
            if body.contact is not None:
                if body.contact == "":
                    sets.append("contact_id = NULL"); notes.append("contact cleared")
                else:
                    pid, pname = helpers.contact(cur, body.contact)
                    sets.append("contact_id = %s"); args.append(pid)
                    notes.append(f"contact → {pname}")
            if body.owner_email is not None:
                if body.owner_email == "":
                    sets.append("owner_id = NULL"); notes.append("owner cleared")
                else:
                    aid, name = helpers.agent(cur, body.owner_email)
                    sets.append("owner_id = %s"); args.append(aid)
                    notes.append(f"owner → {name}")
            if body.group is not None:
                sets.append("group_id = %s"); args.append(helpers.group_id(cur, body.group))
                notes.append(f"group → {body.group}")
            if body.pending_until is not None:
                if body.pending_until == "":
                    sets.append("pending_until = NULL"); notes.append("pending cleared")
                else:
                    sets.append("pending_until = %s"); args.append(body.pending_until)
                    notes.append(f"pending until {body.pending_until}")
            if not sets:
                return {"ok": True, "changed": []}
            args += [ticket_id, body.version]
            cur.execute(f"UPDATE desk.tickets SET {', '.join(sets)} "
                        "WHERE id = %s AND version = %s RETURNING version", args)
            updated = cur.fetchone()
            if updated is None:
                raise HTTPException(409, "Version conflict — re-read the ticket and retry")
            if body.state is not None:
                emit_event(cur, "state", ticket_id)
            if body.priority is not None:
                emit_event(cur, "priority", ticket_id)
            if body.owner_email:                     # "" clears — no owner event
                emit_event(cur, "owner", ticket_id)
        auth.audit(conn, "desk", "Ticket updated", f"ticket:{ticket_id}",
                   f"#{ticket_id} · " + " · ".join(notes))
        return {"ok": True, "changed": notes, "version": updated[0]}


class Reclient(BaseModel):
    client: str            # target client name or uuid
    version: int


@router.post("/tickets/{ticket_id}/client")
def reclient_ticket(ticket_id: int, body: Reclient, request: Request):
    """Move a ticket to another client. If it arrived unrouted, the sender's
    auto-created contact is claimed into the new client; still-open Ledger
    entries follow (approved/locked billing never moves — 0009 fn filters,
    and the immutability guard would refuse regardless)."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'edit_props')
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            new_id = helpers.client_id(cur, body.client)
            cur.execute("SELECT name, is_sentinel FROM shared.clients WHERE id = %s",
                        (new_id,))
            new_name, new_sentinel = cur.fetchone()
            if new_sentinel:
                raise HTTPException(422, "Tickets leave Unassigned intake — they don't move into it")
            old_id = row[1]
            if new_id == old_id:
                return {"ok": True, "changed": [], "version": row[3]}
            cur.execute("""SELECT c.name, c.is_sentinel, t.contact_id
                             FROM desk.tickets t JOIN shared.clients c ON c.id = t.client_id
                            WHERE t.id = %s""", (ticket_id,))
            old_name, old_sentinel, contact_id = cur.fetchone()
            cur.execute("""UPDATE desk.tickets SET client_id = %s
                            WHERE id = %s AND version = %s RETURNING version""",
                        (new_id, ticket_id, body.version))
            updated = cur.fetchone()
            if updated is None:
                raise HTTPException(409, "Version conflict — re-read the ticket and retry")
            claimed = None
            if contact_id and old_sentinel:   # claim the sender out of the intake pool
                cur.execute("""UPDATE shared.contacts SET client_id = %s
                                WHERE id = %s AND client_id = %s RETURNING name""",
                            (new_id, contact_id, old_id))
                r = cur.fetchone()
                claimed = r[0] if r else None
            cur.execute("DELETE FROM desk.ticket_tags WHERE ticket_id = %s AND tag = 'unrouted'",
                        (ticket_id,))
            cur.execute("SELECT moved, kept FROM ledger.reclient_ticket_entries(%s, %s)",
                        (ticket_id, new_id))
            moved, kept = cur.fetchone()
            bits = [f"Moved to {new_name}"]
            if claimed:
                bits.append(f"{claimed} added to their contacts")
            if moved:
                bits.append(f"{moved} open time entr{'y follows' if moved == 1 else 'ies follow'}")
            if kept:
                bits.append(f"{kept} stay with {old_name} (approved/locked billing)")
            cur.execute("""INSERT INTO desk.articles (ticket_id, kind, author, author_id, body)
                           VALUES (%s, 'sys', %s, %s, %s)""",
                        (ticket_id, who.get("name") or who.get("label") or "API",
                         who.get("agent_id"), " · ".join(bits)))
        auth.audit(conn, "desk", "Ticket moved to client", f"ticket:{ticket_id}",
                   f"#{ticket_id} · {old_name} → {new_name}"
                   + (" · sender claimed as contact" if claimed else "")
                   + (f" · {moved} entries moved, {kept} kept" if (moved or kept) else ""))
        return {"ok": True, "changed": [f"client → {new_name}"], "version": updated[0]}


class Tags(BaseModel):
    add: list[str] = []
    remove: list[str] = []


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


class NewTime(BaseModel):
    started_at: str
    ended_at: str
    activity_type: str
    technician_email: str
    article_id: str | None = None      # ride on an existing note/reply
    task_id: str | None = None
    note: str = ""


@router.post("/tickets/{ticket_id}/time", status_code=201)
def add_time(ticket_id: int, body: NewTime, request: Request):
    """A standalone or article-attached time entry — the '+ time' button on an
    existing note. Composer-attached time still travels with its article."""
    _sane_span(getattr(body, 'started_at', None), getattr(body, 'ended_at', None))
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'log_time')
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            client_id = row[1]
            tech_id, tech_name = helpers.agent(cur, body.technician_email)
            type_id = helpers.activity_type_id(cur, body.activity_type)
            if body.article_id:
                cur.execute("""SELECT 1 FROM desk.articles
                                WHERE id = %s AND ticket_id = %s
                                  AND kind IN ('note', 'reply')""",
                            (body.article_id, ticket_id))
                if cur.fetchone() is None:
                    raise HTTPException(422, "Article not on this ticket (or not a note/reply)")
            cur.execute("""INSERT INTO ledger.time_entries
                             (ticket_id, task_id, client_id, tech_id, activity_type_id,
                              started_at, ended_at, note, article_id)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                           RETURNING id, hours""",
                        (ticket_id, body.task_id, client_id, tech_id, type_id,
                         body.started_at, body.ended_at, body.note[:140], body.article_id))
            entry_id, hours = cur.fetchone()
            cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s", (ticket_id,))
        auth.audit(conn, "desk", "Time attached", f"ticket:{ticket_id}",
                   f"#{ticket_id} · {tech_name} · {hours} h · {body.activity_type}"
                   + (" · on article" if body.article_id else ""))
        return {"id": str(entry_id), "hours": float(hours)}


class PatchTime(BaseModel):
    started_at: str | None = None
    ended_at: str | None = None
    activity_type: str | None = None
    task_id: str | None = None         # "" clears
    void: bool | None = None           # remove-from-ticket = void, never delete
    void_reason: str = ""


@router.patch("/time/{entry_id}")
def patch_time(entry_id: str, body: PatchTime, request: Request):
    """Edit or void a time entry from the ticket view. Own entries need
    log_time; someone else's need see_billing. The DB freeze guard (approved
    timesheets, closed periods — SECURITY DEFINER as of 0012) still fires."""
    _sane_span(getattr(body, 'started_at', None), getattr(body, 'ended_at', None))
    with db.connect() as conn:
        who = auth.require(conn, request)
        with conn.cursor() as cur:
            cur.execute("""SELECT e.tech_id, e.ticket_id, e.hours
                             FROM ledger.time_entries e WHERE e.id = %s""", (entry_id,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such time entry")
            tech_id, ticket_id, old_hours = row
            if who["kind"] == "session" and tech_id != who["agent_id"]:
                auth.need(who, 'see_billing')
            else:
                auth.need(who, 'log_time', 'see_billing')
            if ticket_id is not None:
                trow = helpers.ticket_or_404(cur, ticket_id)
                helpers.refuse_if_locked_project(trow)
            sets, args, notes = [], [], []
            if body.started_at is not None:
                sets.append("started_at = %s"); args.append(body.started_at)
            if body.ended_at is not None:
                sets.append("ended_at = %s"); args.append(body.ended_at)
            if body.started_at is not None or body.ended_at is not None:
                notes.append("span edited")
            if body.activity_type is not None:
                sets.append("activity_type_id = %s")
                args.append(helpers.activity_type_id(cur, body.activity_type))
                notes.append(f"type → {body.activity_type}")
            if body.task_id is not None:
                if body.task_id == "":
                    sets.append("task_id = NULL"); notes.append("task cleared")
                else:
                    sets.append("task_id = %s"); args.append(body.task_id)
                    notes.append("task moved")
            if body.void:
                sets += ["status = 'void'", "voided_at = now()", "void_reason = %s"]
                args.append(body.void_reason or "removed from ticket")
                notes.append("voided")
            if not sets:
                return {"ok": True, "changed": []}
            try:
                cur.execute(f"""UPDATE ledger.time_entries SET {', '.join(sets)}
                                 WHERE id = %s AND ts_approved_at IS NULL
                               RETURNING hours""", (*args, entry_id))
            except pg_errors.RaiseException as e:   # the freeze guard said no
                raise HTTPException(409, e.diag.message_primary or "Entry is immutable")
            updated = cur.fetchone()
            if updated is None:
                raise HTTPException(409, "Entry is manager-approved — revoke the timesheet approval first")
        auth.audit(conn, "desk", "Time entry updated",
                   f"entry:{entry_id}",
                   (f"#{ticket_id} · " if ticket_id else "") + " · ".join(notes)
                   + f" · {old_hours} → {updated[0]} h")
        return {"ok": True, "changed": notes, "hours": float(updated[0])}


@router.post("/tickets/{ticket_id}/tags")
def tags(ticket_id: int, body: Tags, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'edit_props')
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            for t in body.add:
                cur.execute("""INSERT INTO desk.ticket_tags (ticket_id, tag)
                               VALUES (%s, %s) ON CONFLICT DO NOTHING""",
                            (ticket_id, t.lower().strip().replace(" ", "-")))
            for t in body.remove:
                cur.execute("DELETE FROM desk.ticket_tags WHERE ticket_id = %s AND tag = %s",
                            (ticket_id, t))
        if body.add or body.remove:
            auth.audit(conn, "desk", "Tags updated", f"ticket:{ticket_id}",
                       f"#{ticket_id} +[{', '.join(body.add)}] -[{', '.join(body.remove)}]")
        return {"ok": True}


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


class TimeSpec(BaseModel):
    started_at: str
    ended_at: str
    activity_type: str
    technician_email: str
    task_id: str | None = None


class NewArticle(BaseModel):
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
        with conn.cursor() as cur:
            row = helpers.ticket_or_404(cur, ticket_id)
            helpers.refuse_if_locked_project(row)
            client_id = row[1]
            author_id, author_name = helpers.agent(cur, body.author_email)
            sent, mail_to, out_mid = False, None, None
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
                cur.execute("""SELECT m.address, m.display_name
                                 FROM desk.mailboxes m
                                 JOIN desk.tickets t ON t.group_id = m.group_id
                                WHERE t.id = %s AND NOT m.paused
                                ORDER BY m.address LIMIT 1""", (ticket_id,))
                mbrow = cur.fetchone()
                if mbrow is None:
                    raise HTTPException(409, "No mailbox is attached to this ticket's group")
                mb_addr, mb_name = mbrow
                cur.execute("""SELECT t.title, t.cc,
                                 (SELECT ar.message_id FROM desk.articles ar
                                   WHERE ar.ticket_id = t.id AND ar.message_id IS NOT NULL
                                   ORDER BY ar.sent_at DESC LIMIT 1),
                                 COALESCE((SELECT array_agg(ar.message_id ORDER BY ar.sent_at)
                                   FROM desk.articles ar
                                  WHERE ar.ticket_id = t.id AND ar.message_id IS NOT NULL), '{}')
                                FROM desk.tickets t WHERE t.id = %s""", (ticket_id,))
                title, cc_list, last_mid, all_mids = cur.fetchone()
                if mailer.outbound_enabled(cur):
                    out_mid = mailer.send_reply(
                        cur, mailbox_address=mb_addr, display_name=mb_name or "",
                        to=mail_to, cc=list(cc_list or []),
                        subject=f"[#{ticket_id}] {title}", body=body.body,
                        in_reply_to=last_mid, references=list(all_mids or []))
                    sent = True
            cur.execute("""INSERT INTO desk.articles
                             (ticket_id, kind, author, author_id, body,
                              mail_from, mail_to, message_id)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                        (ticket_id, body.kind, author_name, author_id, body.body,
                         None if body.kind != "reply" else None,
                         mail_to, out_mid))
            (article_id,) = cur.fetchone()
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
            cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s", (ticket_id,))
        detail = f"#{ticket_id} · {body.kind} by {author_name}"
        if body.kind == "reply":
            detail += (f" · mailed to {mail_to}" if sent
                       else f" · to {mail_to} — RECORDED ONLY (outbound disabled)")
        if entry_id:
            detail += f" · {hours} h → Ledger"
        auth.audit(conn, "desk",
                   ("Reply sent" if sent else "Reply recorded") if body.kind == "reply"
                   else "Note added",
                   f"ticket:{ticket_id}", detail)
        return {"article_id": str(article_id), "sent": sent, "to": mail_to,
                "time_entry_id": str(entry_id) if entry_id else None}
