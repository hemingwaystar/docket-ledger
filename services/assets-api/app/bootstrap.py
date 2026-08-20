"""GET /api/bootstrap — the whole Assets UI state in one round trip:
me, clients (light directory), assets, licenses, contracts (covered assetIds
embedded), events (per-entity feed tail), audit (app-filtered, actor resolved
to a display name — the Docket JOIN pattern), cfg — 8 keys, and the UI's
mapIn() consumes every one (hydration completeness, row 36's law)."""
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from . import auth, db

router = APIRouter()


@router.get("/api/bootstrap")
def bootstrap(request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        if who["kind"] != "session":
            raise HTTPException(401, "Session required")
        ms = lambda dt: int(dt.timestamp() * 1000) if dt else None
        iso = lambda d: d.isoformat() if d else None
        out = {"me": {"name": who["name"], "email": who["email"],
                      "initials": "".join(w[0] for w in who["name"].split()[:2]).upper(),
                      "perms": sorted(who["perms"])}}
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""SELECT id, name, is_sentinel, archived_at
                             FROM shared.clients ORDER BY is_sentinel DESC, name""")
            out["clients"] = [{"id": str(r["id"]), "name": r["name"],
                               "sentinel": r["is_sentinel"],
                               "archived": r["archived_at"] is not None}
                              for r in cur.fetchall()]
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
                              "costCents": r["cost_cents"], "note": r["note"],
                              "archived": r["archived_at"] is not None,
                              "version": r["version"], "createdAt": ms(r["created_at"]),
                              "updatedAt": ms(r["updated_at"])}
                             for r in cur.fetchall()]
            # ends_on is the CURRENT term's end: recurring terms roll forward
            # by however many whole terms have elapsed (a recurring item never
            # "expires" — Build 30's worker advances the anchor authoritatively
            # when it posts each renewal; until then the roll is derived here)
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
                                "costCents": r["cost_cents"], "note": r["note"],
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
                                 "costCents": r["cost_cents"],
                                 "archived": r["archived_at"] is not None,
                                 "version": r["version"], "updatedAt": ms(r["updated_at"]),
                                 "assetIds": [str(a) for a in r["asset_ids"]]}
                                for r in cur.fetchall()]
            cur.execute("""SELECT id, kind, entity_id, author, body, created_at
                             FROM assets.asset_events ORDER BY id DESC LIMIT 400""")
            out["events"] = [{"id": r["id"], "kind": r["kind"], "entityId": str(r["entity_id"]),
                              "author": r["author"], "body": r["body"],
                              "ts": ms(r["created_at"])} for r in cur.fetchall()]
            cur.execute("""SELECT e.at, COALESCE(a.name, e.actor) AS who, e.action,
                                  e.entity, e.detail
                             FROM audit.events e
                             LEFT JOIN shared.agents a ON e.actor = 'agent:' || a.id::text
                            WHERE e.app IN ('assets', 'auth')
                            ORDER BY e.at DESC LIMIT 200""")
            out["audit"] = [{"ts": ms(r["at"]), "actor": r["who"], "action": r["action"],
                             "entityId": r["entity"], "detail": r["detail"] or ""}
                            for r in cur.fetchall()]
            cur.execute("SELECT value FROM shared.app_config WHERE key = 'assets'")
            row = cur.fetchone()
            out["cfg"] = (row["value"] if row and isinstance(row["value"], dict)
                          else {"lapse_lead_days": 60, "lapse_group": "Alerts",
                                "lapse_kinds": {"warranty": True, "license": True, "contract": True}})
        return out
