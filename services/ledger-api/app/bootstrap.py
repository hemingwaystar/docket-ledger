"""GET /api/bootstrap — the whole Ledger UI state in one round trip:
me, clients (rates/access/default-rate opt-ins folded in), techs (with
group memberships), groups, roles (ledger perms), types (+rate history),
defaultRates, audit tail, cfg, odooSecret, periods, entries, projects —
13 keys, and the UI's mapIn() consumes every one (hydration completeness,
ledger row 36's lesson)."""
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from . import auth, db
from .helpers import entry_scope_where

router = APIRouter()


@router.get("/api/bootstrap")
def bootstrap(request: Request, limit: int = 1000):
    """Ledger prototype-shaped state: directory, entries, periods, projects."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        ms = lambda dt: int(dt.timestamp() * 1000) if dt else None
        out = {"me": {"name": who["name"], "email": who["email"],
                      "initials": "".join(w[0] for w in who["name"].split()[:2]).upper(),
                      "perms": sorted(who["perms"])}}
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""SELECT c.id, c.name, c.is_sentinel, c.billing_cycle,
                                  c.billable_default, c.archived_at,
                                  (SELECT cr.rate_cents FROM ledger.client_rates cr
                                    WHERE cr.client_id = c.id AND cr.activity_type_id IS NULL
                                    ORDER BY cr.valid_from DESC LIMIT 1) AS wide_rate
                             FROM shared.clients c ORDER BY c.is_sentinel DESC, c.name""")
            clients = {str(r["id"]): {"id": str(r["id"]), "zorg": str(r["id"])[:8],
                       "name": r["name"],
                       "sentinel": r["is_sentinel"], "cycle": r["billing_cycle"],
                       "rateOverride": (r["wide_rate"] / 100) if r["wide_rate"] is not None else None,
                       "billableDefault": r["billable_default"],
                       "billableDefaultHist": [],
                       "archived": r["archived_at"] is not None,
                       "useDefaults": False, "useDefaultsHist": [], "defaultTypeFlags": {},
                       "rates": {}, "access": {"mode": "all", "techs": [], "groups": []}}
                       for r in cur.fetchall()}
            cur.execute("SELECT client_id, mode, tech_ids, group_ids FROM ledger.client_access")
            for r in cur.fetchall():
                c = clients.get(str(r["client_id"]))
                if c is not None:
                    c["access"] = {"mode": r["mode"],
                                   "techs": [str(t) for t in r["tech_ids"]],
                                   "groups": [str(g) for g in r["group_ids"]]}
            cur.execute("""SELECT client_id, activity_type_id, valid_from, rate_cents, billable
                             FROM ledger.client_rates ORDER BY valid_from""")
            for r in cur.fetchall():
                c = clients.get(str(r["client_id"]))
                if c is None:
                    continue
                day = r["valid_from"].isoformat()
                rate = (r["rate_cents"] / 100) if r["rate_cents"] is not None else None
                if r["activity_type_id"] is None:      # client-wide override lane
                    c["rateOverride"] = rate           # rows are date-ordered → last wins
                    c.setdefault("rateOverrideHist", []).append({"from": day, "rate": rate})
                    if r["billable"] is not None:      # 0038: the billable-by-default flag
                        c["billableDefault"] = r["billable"]   # lane = pricing truth for display
                        c["billableDefaultHist"].append({"from": day, "billable": r["billable"]})
                else:
                    o = c["rates"].setdefault(str(r["activity_type_id"]),
                                              {"rate": None, "billable": None,
                                               "rateHist": [], "billableHist": []})
                    o["rate"] = rate
                    o["rateHist"].append({"from": day, "rate": rate})
                    if r["billable"] is not None:
                        o["billable"] = r["billable"]
                        o["billableHist"].append({"from": day, "billable": r["billable"]})
            cur.execute("""SELECT client_id, activity_type_id, valid_from, enabled
                             FROM ledger.client_default_rate_optin ORDER BY valid_from""")
            for r in cur.fetchall():
                c = clients.get(str(r["client_id"]))
                if c is None:
                    continue
                day = r["valid_from"].isoformat()
                if r["activity_type_id"] is None:      # the client-wide switch lane
                    c["useDefaults"] = r["enabled"]    # rows are date-ordered → last wins
                    c["useDefaultsHist"].append({"from": day, "enabled": r["enabled"]})
                else:
                    o = c["defaultTypeFlags"].setdefault(str(r["activity_type_id"]),
                                                         {"enabled": None, "hist": []})
                    o["enabled"] = r["enabled"]
                    o["hist"].append({"from": day, "enabled": r["enabled"]})
            out["clients"] = list(clients.values())
            # ALL agents ride, active flagged — entries reference deactivated
            # techs forever, and a tech(id) miss threw in Approvals/Reports/
            # Clients, bricking the view (audit). Pickers label inactive.
            cur.execute("""SELECT a.id, a.name, a.initials, a.email, a.active,
                             COALESCE((SELECT array_agg(ag.group_id) FROM shared.agent_groups ag
                                        WHERE ag.agent_id = a.id), '{}') AS gids
                             FROM shared.agents a ORDER BY a.name""")
            out["techs"] = [{"id": str(r["id"]), "name": r["name"], "initials": r["initials"],
                             "email": r["email"], "active": r["active"],
                             "groups": [str(g) for g in r["gids"]]}
                            for r in cur.fetchall()]
            # group-based client access + the read-only Directory mirror need
            # these on a fresh load — suite-bridge events only supplement
            cur.execute("SELECT id, name, active FROM shared.groups ORDER BY name")
            out["groups"] = [{"id": str(r["id"]), "name": r["name"], "active": r["active"]}
                             for r in cur.fetchall()]
            cur.execute("""SELECT r.name, r.note, r.active,
                             COALESCE((SELECT array_agg(permission_id)
                                        FROM shared.role_permissions rp
                                       WHERE rp.role_id = r.id), '{}') AS perms
                             FROM shared.roles r ORDER BY r.name""")
            out["roles"] = [{"name": r["name"], "note": r["note"], "active": r["active"],
                             "ledgerPerms": sorted(p[2:] for p in r["perms"]
                                                   if p.startswith("l_"))}
                            for r in cur.fetchall()]
            cur.execute("""SELECT t.id, t.name, t.billable, t.is_sentinel, t.active,
                                  (SELECT tr.rate_cents FROM ledger.activity_type_rates tr
                                    WHERE tr.activity_type_id = t.id
                                    ORDER BY tr.valid_from DESC LIMIT 1) AS rate
                             FROM ledger.activity_types t
                            ORDER BY t.is_sentinel, t.name""")
            out["types"] = [{"id": str(r["id"]), "name": r["name"], "billable": r["billable"],
                             "sentinel": r["is_sentinel"], "active": r["active"], "note": "",
                             "rate": (r["rate"] / 100) if r["rate"] is not None else 0,
                             "rateHist": [], "billableHist": []}
                            for r in cur.fetchall()]
            tmap = {t["id"]: t for t in out["types"]}
            cur.execute("""SELECT activity_type_id, valid_from, rate_cents, billable
                             FROM ledger.activity_type_rates ORDER BY valid_from""")
            for r in cur.fetchall():
                t = tmap.get(str(r["activity_type_id"]))
                if t is None:
                    continue
                t["rateHist"].append({"from": r["valid_from"].isoformat(),
                                      "rate": r["rate_cents"] / 100})
                if r["billable"] is not None:
                    t["billableHist"].append({"from": r["valid_from"].isoformat(),
                                              "billable": r["billable"]})
            cur.execute("""SELECT activity_type_id, valid_from, rate_cents
                             FROM ledger.default_rates ORDER BY valid_from""")
            out["defaultRates"] = {}
            for r in cur.fetchall():
                d = out["defaultRates"].setdefault(str(r["activity_type_id"]),
                                                   {"rate": None, "hist": []})
                rate = (r["rate_cents"] / 100) if r["rate_cents"] is not None else None
                d["rate"] = rate
                d["hist"].append({"from": r["valid_from"].isoformat(), "rate": rate})
            # the audit tail ships only to roles holding l_view_audit (user
            # decision 2026-08-20 — enforced server-side, not just the hidden
            # tab); the KEY always rides so mapIn stays complete (row 36)
            if "l_view_audit" in who["perms"]:
                cur.execute("""SELECT at, actor, action, entity, detail FROM audit.events
                                WHERE app IN ('ledger', 'auth')
                                ORDER BY at DESC LIMIT 200""")
                out["audit"] = [{"ts": ms(r["at"]), "actor": r["actor"], "action": r["action"],
                                 "entityId": r["entity"], "detail": r["detail"] or ""}
                                for r in cur.fetchall()]
            else:
                out["audit"] = []
            cur.execute("""SELECT key, value FROM shared.app_config
                            WHERE key IN ('ledger','odoo','retainers')""")
            cfg = {r["key"]: (r["value"] if isinstance(r["value"], dict) else {})
                   for r in cur.fetchall()}
            out["cfg"] = cfg
            cur.execute("SELECT rotated_at, rotated_by FROM shared.secrets WHERE name = 'odoo'")
            row = cur.fetchone()
            out["odooSecret"] = ({"at": ms(row["rotated_at"]), "by": row["rotated_by"]}
                                 if row else None)
            cur.execute("""SELECT bp.id, bp.client_id, bp.period_key, bp.status,
                                  bp.export_ref, bp.approved_at, bp.exported_at,
                                  ag.name AS approved_by_name
                             FROM ledger.billing_periods bp
                             LEFT JOIN shared.agents ag ON ag.id = bp.approved_by
                            WHERE bp.status <> 'open'
                               OR EXISTS (SELECT 1 FROM ledger.time_entries e
                                           WHERE e.period_id = bp.id
                                             AND e.status <> 'void')
                            ORDER BY bp.period_key""")
            out["periods"] = [{"id": str(r["id"]), "clientId": str(r["client_id"]),
                               "key": r["period_key"], "status": r["status"],
                               "exportRef": r["export_ref"],
                               "approvedAt": ms(r["approved_at"]),
                               "approvedBy": r["approved_by_name"],
                               "exportedAt": ms(r["exported_at"])} for r in cur.fetchall()]
            # visibility scoping (audit): the same rule the UI's scopedEntries
            # applies now gates the DATA — l_view_own sessions get their own
            # rows only, client access modes apply unless l_all_clients
            scope_sql, scope_args = entry_scope_where(who)
            cur.execute(f"SELECT count(*) FROM ledger.time_entries e WHERE {scope_sql}",
                        scope_args)
            out["entriesTotal"] = cur.fetchone()["count"]
            cur.execute(f"""SELECT e.id, e.ticket_id, e.task_id, e.client_id, e.tech_id,
                                  e.activity_type_id, e.article_id, e.started_at, e.ended_at, e.hours,
                                  COALESCE(NULLIF(e.note, ''),
                                           left(ar.body, 140), '') AS note,
                                  e.status, e.void_reason, e.voided_at,
                                  e.submitted_at, e.ts_approved_at, e.ts_approved_by,
                                  e.returned_at, e.returned_by, e.return_reason,
                                  e.created_at,
                                  tk.title AS ticket_title,
                                  pt.label AS task_label,
                                  ap.name AS approver_name,
                                  rb.name AS returner_name,
                                  bp.period_key
                             FROM ledger.time_entries e
                             LEFT JOIN desk.tickets tk ON tk.id = e.ticket_id
                             LEFT JOIN desk.project_tasks pt ON pt.id = e.task_id
                             LEFT JOIN desk.articles ar
                               ON ar.id = e.article_id AND ar.deleted_at IS NULL
                             LEFT JOIN shared.agents ap ON ap.id = e.ts_approved_by
                             LEFT JOIN shared.agents rb ON rb.id = e.returned_by
                             LEFT JOIN ledger.billing_periods bp ON bp.id = e.period_id
                            WHERE {scope_sql}
                            ORDER BY e.started_at DESC LIMIT %s""",
                        (*scope_args, limit))
            out["entries"] = [{
                "id": str(r["id"]), "zEntryId": str(r["id"])[:8],
                "zArticleId": str(r["article_id"])[:8] if r["article_id"] else None,
                "zTicket": r["ticket_id"], "ticketTitle": r["ticket_title"] or "",
                "clientId": str(r["client_id"]), "techId": str(r["tech_id"]),
                "typeId": str(r["activity_type_id"]), "content": r["note"] or "",
                "startedAt": ms(r["started_at"]), "endedAt": ms(r["ended_at"]),
                "hours": float(r["hours"]), "status": r["status"],
                "source": "api", "createdAt": ms(r["created_at"]),
                "voidedAt": ms(r["voided_at"]), "voidReason": r["void_reason"],
                "zDeleted": False,
                "submitted": r["submitted_at"] is not None,
                "submittedAt": ms(r["submitted_at"]),
                "tsApproved": r["ts_approved_at"] is not None,
                "tsApprovedAt": ms(r["ts_approved_at"]),
                "tsApprovedBy": r["approver_name"],
                "returnedAt": ms(r["returned_at"]), "returnedBy": r["returner_name"],
                "returnReason": r["return_reason"],
                # the server's period assignment is the billing truth — the
                # UI's entryPeriod() prefers this over its browser-local
                # bucketing, which desynced near month/week ends (audit)
                "periodKey": r["period_key"],
                "zTask": ({"id": str(r["task_id"]), "label": r["task_label"] or ""}
                          if r["task_id"] else None)} for r in cur.fetchall()]
            # the FULL shape the suite-bridge 'project-approved' message
            # carries — clientId/title/tasks were missing, so flat fees
            # vanished from every tally after a reload (clientId undefined)
            # and task-priced entries crashed priced() on p.tasks (audit)
            cur.execute("""SELECT p.ticket_id, p.billing_model, p.project_flat_cents,
                                  p.status, p.approved_at, t.client_id, t.title
                             FROM desk.projects p
                             JOIN desk.tickets t ON t.id = p.ticket_id
                            WHERE p.status = 'approved'""")
            projects = {r["ticket_id"]: {
                "zTicket": r["ticket_id"], "ticket": r["ticket_id"],
                "title": r["title"], "clientId": str(r["client_id"]),
                "pmode": "flat" if r["billing_model"] == "project_flat" else "tasks",
                "projectFlat": (r["project_flat_cents"] or 0) / 100 or None,
                "approvedAt": ms(r["approved_at"]), "approvedBy": "Docket",
                "tasks": []} for r in cur.fetchall()}
            if projects:
                cur.execute("""SELECT ticket_id, id, label, billing_mode,
                                      rate_cents, flat_cents
                                 FROM desk.project_tasks
                                WHERE ticket_id = ANY(%s) ORDER BY position""",
                            (list(projects),))
                for r in cur.fetchall():
                    projects[r["ticket_id"]]["tasks"].append({
                        "id": str(r["id"]), "label": r["label"],
                        "mode": r["billing_mode"],
                        "rate": (r["rate_cents"] / 100) if r["rate_cents"] is not None else None,
                        "flat": (r["flat_cents"] / 100) if r["flat_cents"] is not None else None})
            out["projects"] = list(projects.values())
        # money visibility (audit): every rate lane ships only with
        # l_see_amounts — same server-side rule as the audit tail above.
        # Keys/shapes stay intact (mapIn completeness); only values blank.
        # Each lane keeps shipping to the role that ADMINISTERS it (manage
        # perms), because those editors write state values back — blanking
        # what they edit would let a save overwrite real rates with blanks.
        if "l_see_amounts" not in who["perms"]:
            if "l_manage_clients" not in who["perms"]:
                for c in out["clients"]:
                    c["rateOverride"] = None
                    c.pop("rateOverrideHist", None)
                    for o in c["rates"].values():
                        o["rate"] = None
                        o["rateHist"] = []
            if "l_manage_types" not in who["perms"]:
                for t in out["types"]:
                    t["rate"] = 0
                    t["rateHist"] = []
            if "l_manage_settings" not in who["perms"]:
                out["defaultRates"] = {}
            for p in out["projects"]:   # ledger has no project-money editor —
                p["projectFlat"] = None  # display-only, safe to blank outright
                for t in p["tasks"]:
                    t["rate"] = None
                    t["flat"] = None
        return out
