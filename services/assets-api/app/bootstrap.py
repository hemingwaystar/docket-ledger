"""GET /api/bootstrap — the whole Assets UI state in one round trip:
me, clients (light directory), assets, licenses, contracts (covered assetIds
embedded), events (per-entity feed tail), audit (app-filtered, actor resolved
to a display name — the Docket JOIN pattern), cfg — 8 keys, and the UI's
mapIn() consumes every one (hydration completeness, row 36's law)."""
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from . import auth, db

router = APIRouter()


def _bundle_stamp():
    """Served-bundle fingerprint (audit) — the UI offers a reload when a
    deploy changes it; desk bootstrap.py documents the pattern."""
    import hashlib
    import os
    h = hashlib.sha1()
    root = os.path.join(os.path.dirname(__file__), "..", "webui")
    for dirpath, _dirs, files in sorted(os.walk(root)):
        for f in sorted(files):
            try:
                st = os.stat(os.path.join(dirpath, f))
                h.update(f"{f}:{st.st_size}:{int(st.st_mtime)}".encode())
            except OSError:
                pass
    return h.hexdigest()[:12]


BUNDLE = _bundle_stamp()


@router.get("/api/bootstrap")
def bootstrap(request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        ms = lambda dt: int(dt.timestamp() * 1000) if dt else None
        iso = lambda d: d.isoformat() if d else None
        # read-side RBAC, enforced server-side (audit; the ledger-bootstrap
        # precedent): a_view gates the dataset, a_see_costs the money fields,
        # a_view_audit the audit tail. Every key still rides — [] / None —
        # so mapIn stays complete (row 36's law) and the nav gates just work.
        can_view = "a_view" in who["perms"]
        cost = (lambda c: c) if "a_see_costs" in who["perms"] else (lambda c: None)
        out = {"bundle": BUNDLE,
               "me": {"name": who["name"], "email": who["email"],
                      "initials": "".join(w[0] for w in who["name"].split()[:2]).upper(),
                      "perms": sorted(who["perms"])},
               "assets": [], "licenses": [], "contracts": [], "events": []}
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""SELECT id, name, is_sentinel, archived_at
                             FROM shared.clients ORDER BY is_sentinel DESC, name""")
            out["clients"] = [{"id": str(r["id"]), "name": r["name"],
                               "sentinel": r["is_sentinel"],
                               "archived": r["archived_at"] is not None}
                              for r in cur.fetchall()]
            if can_view:
                cur.execute("""SELECT id, ci_tag, name, atype, client_id, assigned_to, status,
                                      serial, vendor, purchased_on, warranty_until, cost_cents,
                                      note, archived_at, version, created_at, updated_at
                                 FROM assets.assets ORDER BY ci_tag""")
                out["assets"] = [{"id": str(r["id"]), "ciTag": r["ci_tag"], "name": r["name"],
                                  "atype": r["atype"], "clientId": str(r["client_id"]),
                                  "assignedTo": r["assigned_to"], "status": r["status"],
                                  "serial": r["serial"], "vendor": r["vendor"],
                                  "purchasedOn": iso(r["purchased_on"]),
                                  "warrantyUntil": iso(r["warranty_until"]),
                                  "costCents": cost(r["cost_cents"]), "note": r["note"],
                                  "archived": r["archived_at"] is not None,
                                  "version": r["version"], "createdAt": ms(r["created_at"]),
                                  "updatedAt": ms(r["updated_at"])}
                                 for r in cur.fetchall()]
            # ends_on is the CURRENT term's end: recurring terms roll forward
            # by however many whole terms have elapsed (a recurring item never
            # "expires" — Build 30's worker advances the anchor authoritatively
            # when it posts each renewal; until then the roll is derived here)
            if can_view:
                cur.execute("""SELECT id, product, vendor, client_id, seats_total, seats_used,
                                      term_months, recurring, term_started_on,
                                      (term_started_on + make_interval(months => term_months *
                                         (CASE WHEN recurring
                                                    AND term_started_on + make_interval(months => term_months) <= current_date
                                               THEN floor((extract(year from age(current_date, term_started_on)) * 12
                                                         + extract(month from age(current_date, term_started_on)))
                                                        / term_months)::int + 1
                                               ELSE 1 END)))::date AS ends_on,
                                      cost_cents, note, archived_at, version, updated_at
                                 FROM assets.licenses ORDER BY product""")
                out["licenses"] = [{"id": str(r["id"]), "product": r["product"], "vendor": r["vendor"],
                                    "clientId": str(r["client_id"]) if r["client_id"] else None,
                                    "seatsTotal": r["seats_total"], "seatsUsed": r["seats_used"],
                                    "termMonths": r["term_months"], "recurring": r["recurring"],
                                    "termStartedOn": iso(r["term_started_on"]),
                                    "endsOn": iso(r["ends_on"]),
                                    "costCents": cost(r["cost_cents"]), "note": r["note"],
                                    "archived": r["archived_at"] is not None,
                                    "version": r["version"], "updatedAt": ms(r["updated_at"])}
                                   for r in cur.fetchall()]
                cur.execute("""SELECT c.id, c.vendor, c.kind, c.client_id, c.scope_note,
                                      c.term_months, c.recurring, c.term_started_on,
                                      (c.term_started_on + make_interval(months => c.term_months *
                                         (CASE WHEN c.recurring
                                                    AND c.term_started_on + make_interval(months => c.term_months) <= current_date
                                               THEN floor((extract(year from age(current_date, c.term_started_on)) * 12
                                                         + extract(month from age(current_date, c.term_started_on)))
                                                        / c.term_months)::int + 1
                                               ELSE 1 END)))::date AS ends_on,
                                      c.cost_cents, c.archived_at, c.version, c.updated_at,
                                      COALESCE((SELECT array_agg(ca.asset_id)
                                                 FROM assets.contract_assets ca
                                                WHERE ca.contract_id = c.id), '{}') AS asset_ids
                                 FROM assets.contracts c ORDER BY c.vendor""")
                out["contracts"] = [{"id": str(r["id"]), "vendor": r["vendor"], "kind": r["kind"],
                                     "clientId": str(r["client_id"]), "scopeNote": r["scope_note"],
                                     "termMonths": r["term_months"], "recurring": r["recurring"],
                                     "termStartedOn": iso(r["term_started_on"]),
                                     "endsOn": iso(r["ends_on"]),
                                     "costCents": cost(r["cost_cents"]),
                                     "archived": r["archived_at"] is not None,
                                     "version": r["version"], "updatedAt": ms(r["updated_at"]),
                                     "assetIds": [str(a) for a in r["asset_ids"]]}
                                    for r in cur.fetchall()]
                cur.execute("""SELECT id, kind, entity_id, author, body, created_at
                                 FROM assets.asset_events ORDER BY id DESC LIMIT 400""")
                out["events"] = [{"id": r["id"], "kind": r["kind"], "entityId": str(r["entity_id"]),
                                  "author": r["author"], "body": r["body"],
                                  "ts": ms(r["created_at"])} for r in cur.fetchall()]
            if "a_view_audit" in who["perms"]:
                cur.execute("""SELECT e.at, COALESCE(a.name, e.actor) AS who, e.action,
                                      e.entity, e.detail
                                 FROM audit.events e
                                 LEFT JOIN shared.agents a ON e.actor = 'agent:' || a.id::text
                                WHERE e.app IN ('assets', 'auth')
                                ORDER BY e.at DESC LIMIT 200""")
                out["audit"] = [{"ts": ms(r["at"]), "actor": r["who"], "action": r["action"],
                                 "entityId": r["entity"], "detail": r["detail"] or ""}
                                for r in cur.fetchall()]
                # older rows exist beyond the tail? The audit view fetches
                # date windows from GET /api/audit instead of pretending the
                # tail is everything (audit finding)
                cur.execute("""SELECT count(*) FROM audit.events e
                                WHERE e.app IN ('assets', 'auth')""")
                out["auditTotal"] = cur.fetchone()["count"]
            else:
                out["audit"] = []
                out["auditTotal"] = 0
            cur.execute("SELECT value FROM shared.app_config WHERE key = 'assets'")
            row = cur.fetchone()
            out["cfg"] = (row["value"] if row and isinstance(row["value"], dict)
                          else {"lapse_lead_days": 60, "lapse_group": "Alerts",
                                "lapse_kinds": {"warranty": True, "license": True, "contract": True}})
        return out


@router.get("/api/events")
def entity_events(request: Request, entity_id: str, limit: int = 300):
    """The COMPLETE change feed for one asset/licence/contract — the detail
    modals used to filter bootstrap's global 400-row tail, so an entity whose
    history predated the horizon showed 'no recorded changes' over real rows
    (audit finding)."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        auth.need(who, "a_view")
        ms = lambda dt: int(dt.timestamp() * 1000) if dt else None
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""SELECT id, kind, entity_id, author, body, created_at
                             FROM assets.asset_events
                            WHERE entity_id::text = %s
                            ORDER BY id DESC LIMIT %s""",
                        (entity_id, min(limit, 1000)))
            return {"events": [{"id": r["id"], "kind": r["kind"],
                                "entityId": str(r["entity_id"]),
                                "author": r["author"], "body": r["body"],
                                "ts": ms(r["created_at"])} for r in cur.fetchall()]}


@router.get("/api/audit")
def audit_window(request: Request, date_from: str | None = None,
                 date_to: str | None = None, limit: int = 1000,
                 tz_min: int = 0):
    """Audit rows for a DATE WINDOW — the view's from/to filters query this
    instead of silently filtering the newest-200 bootstrap tail (audit
    finding). Dates are YYYY-MM-DD, inclusive, in the CALLER's local day —
    tz_min is JS getTimezoneOffset() (minutes WEST of UTC), so a
    US-Eastern evening row on the 'to' date stays in the window (review)."""
    import re as _re
    for v in (date_from, date_to):
        if v is not None and not _re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            raise HTTPException(422, "dates must be YYYY-MM-DD")
    if not -900 <= tz_min <= 900:
        raise HTTPException(422, "tz_min out of range")
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        auth.need(who, "a_view_audit")
        ms = lambda dt: int(dt.timestamp() * 1000) if dt else None
        where, args = ["e.app IN ('assets', 'auth')"], []
        if date_from:
            where.append("e.at >= %s::date + make_interval(mins => %s)")
            args += [date_from, tz_min]
        if date_to:
            where.append("e.at < %s::date + interval '1 day' + make_interval(mins => %s)")
            args += [date_to, tz_min]
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(f"""SELECT e.at, COALESCE(a.name, e.actor) AS who, e.action,
                                  e.entity, e.detail
                             FROM audit.events e
                             LEFT JOIN shared.agents a ON e.actor = 'agent:' || a.id::text
                            WHERE {' AND '.join(where)}
                            ORDER BY e.at DESC LIMIT %s""",
                        (*args, min(limit, 5000)))
            return {"events": [{"ts": ms(r["at"]), "actor": r["who"],
                                "action": r["action"], "entityId": r["entity"],
                                "detail": r["detail"] or ""} for r in cur.fetchall()]}
