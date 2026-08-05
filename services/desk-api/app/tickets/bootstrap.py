"""GET /api/bootstrap — the whole app state in one call — and /api/meta,
the select vocabularies."""
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from .. import auth, automations, db
from .common import ST_MAP

router = APIRouter(prefix="/api")


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
            # per-user UI prefs (uprefs:<uuid>, written only via PUT /auth/me/prefs);
            # {} = follow the admin desk_ui defaults
            cur.execute("SELECT value FROM shared.app_config WHERE key = %s",
                        (f"uprefs:{who['agent_id']}",))
            row = cur.fetchone()
            pv = row["value"] if row else {}
            out["me"]["prefs"] = pv if isinstance(pv, dict) else {}
            cur.execute("SELECT id, name, active FROM shared.groups ORDER BY name")
            out["groups"] = [{"id": str(r["id"]), "name": r["name"],
                              "active": r["active"]} for r in cur.fetchall()]
            # mfaPending/mfaAt feed the auth panel (enroll started ≠ enrolled);
            # booleans and a timestamp only — the secret itself never rides
            cur.execute("""SELECT a.id, a.name, a.initials, a.email, r.name AS role,
                             a.password_hash IS NOT NULL AS has_password,
                             a.totp_enrolled_at IS NOT NULL AS mfa,
                             a.totp_secret_enc IS NOT NULL AND a.totp_enrolled_at IS NULL AS mfa_pending,
                             a.totp_enrolled_at,
                             COALESCE((SELECT array_agg(ag.group_id) FROM shared.agent_groups ag
                                        WHERE ag.agent_id = a.id), '{}') AS gids
                             FROM shared.agents a LEFT JOIN shared.roles r ON r.id = a.role_id
                            WHERE a.active ORDER BY a.name""")
            out["agents"] = [{"id": str(r["id"]), "name": r["name"], "initials": r["initials"],
                             "email": r["email"], "role": r["role"] or "Technician",
                             "hasPassword": r["has_password"], "mfa": r["mfa"],
                             "mfaPending": r["mfa_pending"], "mfaAt": ms(r["totp_enrolled_at"]),
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
                             mobile, active, vip
                             FROM shared.contacts ORDER BY name""")
            for r in cur.fetchall():
                c = clients.get(str(r["client_id"]))
                if c is not None:
                    c["contacts"].append({"id": str(r["id"]), "name": r["name"],
                                          "email": r["email"], "title": r["title"],
                                          "dept": r["department"], "phone": r["phone"],
                                          "mobile": r["mobile"], "active": r["active"],
                                          "vip": r["vip"]})
            out["clients"] = list(clients.values())
            cur.execute("SELECT id, name, billable, active FROM ledger.activity_types ORDER BY is_sentinel DESC, name")
            # archived types ride along (active:false) so existing time chips
            # still resolve a name; the composer picker filters via aATYPES()
            out["atypes"] = [{"id": str(r["id"]), "name": r["name"], "billable": r["billable"],
                              "active": r["active"]}
                             for r in cur.fetchall()]
            cur.execute("""SELECT id, label, kind, active, is_system, color, description
                             FROM desk.ticket_states ORDER BY position""")
            # sid = the server uuid — the Settings states editor PATCHes by it;
            # without it every hydrated row's editor is a lying chip (bug #30 class)
            # color/description are raw column values: NULL rides through as
            # null and mapIn falls back to the shipped ST_DECOR defaults
            out["states"] = [{"id": ST_MAP.get(r["label"].lower(),
                                               r["label"].lower().replace(" ", "-")),
                              "sid": str(r["id"]),
                              "label": r["label"], "type": r["kind"],
                              "active": r["active"],
                              "system": r["is_system"],
                              "color": r["color"],
                              "description": r["description"]} for r in cur.fetchall()]
            cur.execute("SELECT id, label, rank, active, color FROM desk.priorities ORDER BY rank")
            # inactive rows ride along too (same rule as atypes) so old
            # tickets still resolve a label and the editor can restore them;
            # color is the raw column — NULL rides through as null and mapIn
            # falls back to the shipped rank-derived flag
            out["priorities"] = [{"id": str(r["id"]), "label": r["label"],
                                  "rank": r["rank"], "active": r["active"],
                                  "color": r["color"]}
                                 for r in cur.fetchall()]
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
            # the GLOBAL send switch (go-live flip) — distinct from each
            # mailbox's own eligibility flag emitted per row below (0022)
            out["outboundEnabled"] = bool((mail_cfg or {}).get("outbound_enabled"))
            cur.execute("""SELECT m.id, m.address, m.display_name, m.group_id, m.paused,
                             m.outbound, m.mailbox_type,
                             COALESCE(p.rank, 2) AS prio,
                             (SELECT count(*) FROM desk.articles ar
                               WHERE ar.mail_to = m.address AND ar.kind = 'mail_in'
                                 AND ar.sent_at::date = current_date) AS today
                             FROM desk.mailboxes m
                             LEFT JOIN desk.priorities p ON p.id = m.default_priority_id
                            ORDER BY m.address""")
            out["mailboxes"] = [{"id": str(r["id"]), "addr": r["address"],
                                 "type": r["mailbox_type"], "groupId": str(r["group_id"]),
                                 "prio": r["prio"], "outbound": r["outbound"],
                                 "desc": r["display_name"] or "",
                                 "status": "paused" if r["paused"] else "connected",
                                 "today": r["today"]} for r in cur.fetchall()]
            # effective outbound sender per board (0026): group_sendas override
            # when one is stored, else the reply resolver's fed-by derivation;
            # override lets the routing card label "override" vs "derived".
            # The ovr join mirrors the resolvers' eligibility predicate EXACTLY
            # (outbound AND NOT paused) — a stale override must not make the UI
            # claim a sender the reply path would skip (truthfulness, bug #32)
            cur.execute("""SELECT g.id, gs.mailbox_id IS NOT NULL AS override,
                             COALESCE(ovr.id, fed.id) AS mailbox_id
                             FROM shared.groups g
                             LEFT JOIN desk.group_sendas gs ON gs.group_id = g.id
                             LEFT JOIN desk.mailboxes ovr ON ovr.id = gs.mailbox_id
                                     AND ovr.outbound AND NOT ovr.paused
                             LEFT JOIN LATERAL (SELECT m.id FROM desk.mailboxes m
                                     WHERE m.group_id = g.id AND NOT m.paused
                                     ORDER BY m.outbound DESC, m.address LIMIT 1) fed ON true
                            ORDER BY g.name""")
            out["groupSendas"] = [{"groupId": str(r["id"]),
                                   "mailboxId": str(r["mailbox_id"]) if r["mailbox_id"] else None,
                                   "override": r["override"]} for r in cur.fetchall()]
            # archived roles ride along (active:false) so the roles cards can
            # show Archived/Restore — pickers already filter; matches Ledger's
            # emission, which never filtered
            cur.execute("""SELECT r.name, r.note, r.is_core, r.entra_group, r.active,
                             COALESCE((SELECT array_agg(permission_id)
                                        FROM shared.role_permissions rp
                                       WHERE rp.role_id = r.id), '{}') AS perms
                             FROM shared.roles r ORDER BY r.name""")
            out["roles"] = [{"name": r["name"], "note": r["note"], "core": r["is_core"],
                             "entra": r["entra_group"] or "",
                             "active": r["active"],
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
                            WHERE key IN ('sla', 'business_hours', 'desk_ui')""")
            eng = {r["key"]: (r["value"] if isinstance(r["value"], dict) else {})
                   for r in cur.fetchall()}
            out["sla"] = eng.get("sla", {})
            out["biz"] = eng.get("business_hours", {})
            # admin queue-tab + dashboard defaults (build 10) — every user needs
            # them and the settings API is admin-gated, so they ride bootstrap
            out["deskUi"] = eng.get("desk_ui", {})
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
                    "links": [], "parentId": None, "children": [],
                    # assigneeIds (0032): additional assigned techs beyond the
                    # single ownerId. A FIELD on each ticket, ALWAYS present —
                    # [] here, overwritten below for tickets that have any — so
                    # the bootstrap desk key COUNT is unchanged and a pre-0032
                    # payload can't crash mapIn.
                    "assigneeIds": [],
                    # schedules (0033): per-tech time blocks on on-hold tickets.
                    # Also a per-ticket FIELD, ALWAYS present ([] here, filled
                    # below), so the desk key COUNT is unchanged and a pre-0033
                    # payload can't crash mapIn. pendingUntil (above) is now the
                    # DERIVED MIN future start over these rows.
                    "schedules": [],
                    "version": r["version"], "articles": [], "time": []}
            if tickets:
                ids = list(tickets)
                # assigneeIds (0032): additional assigned techs per ticket, one
                # aggregate over the ticket_assignees membership join. Attaches
                # the uuid-string list; tickets with none keep the [] default
                # seeded above (so the field is ALWAYS present).
                cur.execute("""SELECT ticket_id,
                                 array_agg(agent_id::text ORDER BY added_at) AS aids
                                 FROM desk.ticket_assignees WHERE ticket_id = ANY(%s)
                                GROUP BY ticket_id""", (ids,))
                for r in cur.fetchall():
                    t = tickets.get(r["ticket_id"])
                    if t is not None:
                        t["assigneeIds"] = list(r["aids"])
                # schedules (0033): per-tech time blocks per ticket. Ordered by
                # (ticket_id, starts_at) and appended in order, so each ticket's
                # list arrives sorted by start. Timestamps are epoch ms (ms()) —
                # same units as every other ticket timestamp, so the UI reuses
                # fmtDT/dtLocalVal without translation; tickets with none keep
                # the [] default seeded above (field ALWAYS present).
                # completed_at/completed_by (0035): per-block completion stamp —
                # NULL completedAt = not done. Drives the struck-through render in
                # both the Schedules bar and the Schedule calendar (build 18/19).
                cur.execute("""SELECT ticket_id, id, agent_id, starts_at, ends_at, note,
                                      completed_at, completed_by
                                 FROM desk.ticket_schedules WHERE ticket_id = ANY(%s)
                                ORDER BY ticket_id, starts_at""", (ids,))
                for r in cur.fetchall():
                    t = tickets.get(r["ticket_id"])
                    if t is not None:
                        t["schedules"].append({"id": str(r["id"]),
                                               "agentId": str(r["agent_id"]),
                                               "startsAt": ms(r["starts_at"]),
                                               "endsAt": ms(r["ends_at"]),
                                               "note": r["note"],
                                               "completedAt": ms(r["completed_at"]),
                                               "completedBy": r["completed_by"]})
                # ticket links — related both ways, child directed; a linked
                # ticket outside the hydrate window still shows as a bare #id
                cur.execute("""SELECT kind, src_id, dst_id FROM desk.ticket_links
                                WHERE voided_at IS NULL
                                  AND (src_id = ANY(%s) OR dst_id = ANY(%s))""",
                            (ids, ids))
                for r in cur.fetchall():
                    if r["kind"] == "child":
                        if r["src_id"] in tickets:
                            tickets[r["src_id"]]["children"].append(r["dst_id"])
                        if r["dst_id"] in tickets:
                            tickets[r["dst_id"]]["parentId"] = r["src_id"]
                    else:
                        if r["src_id"] in tickets:
                            tickets[r["src_id"]]["links"].append(r["dst_id"])
                        if r["dst_id"] in tickets:
                            tickets[r["dst_id"]]["links"].append(r["src_id"])
                # author_id (0001) rides as author.id so the note-edit UI can
                # test authorship (a.author?.id===meId) for the Edit affordance;
                # edited_at/edited_by (0034) carry the "(edited <when>)" marker —
                # both null on every never-edited article. Articles ride WHOLE
                # through mapIn, so these field names ARE what renderArt reads.
                cur.execute("""SELECT ticket_id, id, kind, author, author_id, body, body_html,
                                 is_auto, mail_from, mail_to, sent_at, edited_at, edited_by
                                 FROM desk.articles WHERE ticket_id = ANY(%s)
                                ORDER BY sent_at""", (ids,))
                art_index = {}
                for r in cur.fetchall():
                    art = {"id": str(r["id"]),
                           "kind": "mail-in" if r["kind"] == "mail_in" else r["kind"],
                           "author": {"name": r["author"],
                                      "id": str(r["author_id"]) if r["author_id"] else None},
                           "ts": ms(r["sent_at"]),
                           "body": r["body"], "bodyHtml": r["body_html"],
                           "auto": r["is_auto"],
                           "mailFrom": r["mail_from"], "mailTo": r["mail_to"],
                           "editedAt": ms(r["edited_at"]), "editedBy": r["edited_by"]}
                    art_index[str(r["id"])] = art
                    tickets[r["ticket_id"]]["articles"].append(art)
                if art_index:
                    cur.execute("""SELECT at.article_id, at.id, at.filename,
                                     at.byte_size, at.mime_type
                                     FROM desk.attachments at
                                     JOIN desk.articles ar ON ar.id = at.article_id
                                    WHERE ar.ticket_id = ANY(%s) AND NOT at.is_inline
                                    ORDER BY at.created_at""", (ids,))
                    for r in cur.fetchall():
                        a = art_index.get(str(r["article_id"]))
                        if a is not None:
                            a.setdefault("atts", []).append(
                                {"id": str(r["id"]), "name": r["filename"],
                                 "size": r["byte_size"], "type": r["mime_type"]})
                # locked (0034): the entry sits in an approved/exported billing
                # period. Read via ledger.period_locked() (SECURITY DEFINER) so
                # desk_api needs NO billing_periods grant. Distinct from approved
                # (the manager timesheet sign-off, ts_approved_at) — a period can
                # be locked while an entry is not yet ts_approved, so the UI needs
                # BOTH flags to gate the note-Edit affordance the same way the
                # server does. The article↔entry link (articleId) lets renderArt
                # hang a.time on the note.
                cur.execute("""SELECT e.ticket_id, e.id, e.tech_id, e.activity_type_id,
                                 e.task_id, e.hours, e.started_at, e.ended_at, e.status,
                                 e.submitted_at, e.ts_approved_at, e.article_id, e.version,
                                 ledger.period_locked(e.period_id) AS locked
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
                        "locked": r["locked"],
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
