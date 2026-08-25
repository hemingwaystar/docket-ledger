"""Ledger admin writes — settings, pricing, access:
  PUT /api/config/{key}               ledger | odoo | retainers
  PUT /api/secrets/odoo               write-only, KEK-sealed
  PATCH /api/clients/{id}             the two billing columns Ledger owns
  POST /api/types · PATCH /api/types/{id} · PUT /api/types/{id}/rate
  PUT /api/default-rates/{type_id}    global default rates, opt-in per client
  PUT /api/clients/{id}/rates         per-client overrides, effective today
  PUT /api/clients/{id}/default-rates the 'use defaults' switch + per-type toggles
  PUT /api/clients/{id}/access        all | restricted | group"""
import json
from fastapi import APIRouter, HTTPException, Request
from psycopg import errors as pg_errors
from pydantic import BaseModel
from . import auth, crypto, db

router = APIRouter()

LEDGER_CONFIG_KEYS = ("ledger", "odoo", "retainers")


class ConfigValue(BaseModel):
    value: dict


@router.put("/api/config/{key}")
def put_config(key: str, body: ConfigValue, request: Request):
    """Ledger-owned settings (global defaults, Odoo connector, retainers)."""
    if key not in LEDGER_CONFIG_KEYS:
        raise HTTPException(422, f"Unknown config key — one of {', '.join(LEDGER_CONFIG_KEYS)}")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_manage_settings")
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO shared.app_config (key, value)
                           VALUES (%s, %s)
                           ON CONFLICT (key) DO UPDATE
                             SET value = EXCLUDED.value, updated_at = now(),
                                 updated_by = shared.current_actor(),
                                 version = shared.app_config.version + 1""",
                        (key, json.dumps(body.value)))
        auth.audit(conn, "ledger", "Settings changed", f"config:{key}",
                   f"{key} updated by {who['label']}")
        return {"ok": True}


class SecretValue(BaseModel):
    value: str


@router.put("/api/secrets/{name}")
def put_secret(name: str, body: SecretValue, request: Request):
    """Write-only, KEK-sealed — the Odoo API key never comes back out."""
    if name != "odoo":
        raise HTTPException(422, "Ledger stores only the 'odoo' secret")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_manage_settings")
        blob = crypto.seal(body.value.encode())
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO shared.secrets (name, ciphertext, nonce, kek_id)
                           VALUES (%s, %s, ''::bytea, 'kek-file-1')
                           ON CONFLICT (name) DO UPDATE
                             SET ciphertext = EXCLUDED.ciphertext,
                                 rotated_at = now(),
                                 rotated_by = shared.current_actor()""",
                        (name, blob))
        auth.audit(conn, "ledger", "Secret rotated", f"secret:{name}",
                   f"odoo key stored (envelope-encrypted) by {who['label']} — value not logged")
        return {"ok": True}


class ClientBilling(BaseModel):
    cycle: str | None = None           # monthly | weekly
    billable_default: bool | None = None


@router.patch("/api/clients/{client_id}")
def patch_client_billing(client_id: str, body: ClientBilling, request: Request):
    """The two billing columns Ledger owns on the shared client record."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_manage_clients")
        with conn.cursor() as cur:
            sets, args, notes = [], [], []
            if body.cycle is not None:
                if body.cycle not in ("monthly", "weekly"):
                    raise HTTPException(422, "cycle must be monthly or weekly")
                sets.append("billing_cycle = %s"); args.append(body.cycle)
                notes.append(f"cycle → {body.cycle}")
            if body.billable_default is not None:
                sets.append("billable_default = %s"); args.append(body.billable_default)
                notes.append(f"billable default → {body.billable_default}")
            if not sets:
                return {"ok": True}
            cur.execute(f"UPDATE shared.clients SET {', '.join(sets)} "
                        "WHERE id = %s RETURNING name", (*args, client_id))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such client")
            if body.billable_default is not None:
                # the flag PRICES via the dated client-wide lane (0038's veto
                # rung in priced()); the column stays the Directory's display
                # copy. Carry the current wide rate forward so the dated-unset
                # convention can't silently reset a client-wide rate override.
                cur.execute("""INSERT INTO ledger.client_rates
                                 (client_id, activity_type_id, valid_from, rate_cents, billable)
                               VALUES (%s, NULL, current_date,
                                       (SELECT r.rate_cents FROM ledger.client_rates r
                                         WHERE r.client_id = %s AND r.activity_type_id IS NULL
                                           AND r.valid_from <= current_date
                                         ORDER BY r.valid_from DESC LIMIT 1),
                                       %s)
                               ON CONFLICT (client_id, valid_from) WHERE activity_type_id IS NULL
                                 DO UPDATE SET billable = EXCLUDED.billable""",
                            (client_id, client_id, body.billable_default))
        auth.audit(conn, "ledger", "Client billing changed", f"client:{client_id}",
                   f"{row[0]} · " + " · ".join(notes))
        return {"ok": True}


class NewType(BaseModel):
    name: str
    billable: bool = True


@router.post("/api/types", status_code=201)
def create_type(body: NewType, request: Request):
    """New activity type — appears in every classify picker on next hydrate.
    Rates come afterwards via PUT /api/types/{id}/rate (its first-ever row
    anchors at epoch, so existing entries are never priced at $0)."""
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "The type needs a name")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_manage_types")
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM ledger.activity_types WHERE lower(name) = lower(%s)",
                        (name,))
            if cur.fetchone():
                raise HTTPException(409, f"A type named “{name}” already exists")
            cur.execute("""INSERT INTO ledger.activity_types (name, billable)
                           VALUES (%s, %s) RETURNING id""", (name, body.billable))
            (tid,) = cur.fetchone()
        auth.audit(conn, "ledger", "Activity type created", f"type:{tid}",
                   f"{name} · {'billable' if body.billable else 'non-billable'} · by {who['label']}")
        return {"id": str(tid)}


class TypePatch(BaseModel):
    billable: bool | None = None
    active: bool | None = None
    name: str | None = None


@router.patch("/api/types/{type_id}")
def patch_type(type_id: str, body: TypePatch, request: Request):
    """Activity type edits — the sentinel guard trigger has the final word."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_manage_types")
        cols = {k: v for k, v in body.model_dump().items() if v is not None}
        if not cols:
            return {"ok": True}
        with conn.cursor() as cur:
            if "billable" in cols:
                # prior time keeps prior semantics: anchor the OLD value at
                # epoch on the first flip, then date the new value from today
                cur.execute("""SELECT t.billable,
                                      (SELECT r.rate_cents FROM ledger.activity_type_rates r
                                        WHERE r.activity_type_id = t.id
                                        ORDER BY r.valid_from DESC LIMIT 1),
                                      EXISTS (SELECT 1 FROM ledger.activity_type_rates r
                                               WHERE r.activity_type_id = t.id
                                                 AND r.billable IS NOT NULL)
                                 FROM ledger.activity_types t WHERE t.id = %s""", (type_id,))
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(404, "No such activity type")
                old_billable, latest_rate, has_dated = row
                if not has_dated and old_billable != cols["billable"]:
                    cur.execute("""INSERT INTO ledger.activity_type_rates
                                     (activity_type_id, valid_from, rate_cents, billable)
                                   VALUES (%s, '1970-01-01', %s, %s)
                                   ON CONFLICT (activity_type_id, valid_from)
                                     DO UPDATE SET billable = COALESCE(
                                       ledger.activity_type_rates.billable, EXCLUDED.billable)""",
                                (type_id, latest_rate or 0, old_billable))
                cur.execute("""INSERT INTO ledger.activity_type_rates
                                 (activity_type_id, valid_from, rate_cents, billable)
                               VALUES (%s, current_date, %s, %s)
                               ON CONFLICT (activity_type_id, valid_from)
                                 DO UPDATE SET billable = EXCLUDED.billable""",
                            (type_id, latest_rate or 0, cols["billable"]))
            sets = ", ".join(f"{k} = %s" for k in cols)
            try:
                cur.execute(f"UPDATE ledger.activity_types SET {sets} "
                            "WHERE id = %s RETURNING name", (*cols.values(), type_id))
            except pg_errors.RaiseException as e:
                raise HTTPException(409, e.diag.message_primary or "Type is guarded")
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such activity type")
        auth.audit(conn, "ledger", "Activity type updated", f"type:{type_id}",
                   f"{row[0]} · " + ", ".join(f"{k}={v}" for k, v in cols.items()))
        return {"ok": True}


class TypeRate(BaseModel):
    rate_cents: int


@router.put("/api/types/{type_id}/rate")
def put_type_rate(type_id: str, body: TypeRate, request: Request):
    """Effective-dated base rate — a new row from today; same-day collapses."""
    if body.rate_cents < 0:
        raise HTTPException(422, "rate_cents must be >= 0")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_manage_types")
        with conn.cursor() as cur:
            cur.execute("SELECT EXISTS (SELECT 1 FROM ledger.activity_type_rates "
                        "WHERE activity_type_id = %s)", (type_id,))
            (has_rows,) = cur.fetchone()
            cur.execute("""INSERT INTO ledger.activity_type_rates
                             (activity_type_id, valid_from, rate_cents)
                           VALUES (%s, CASE WHEN %s THEN current_date
                                            ELSE '1970-01-01'::date END, %s)
                           ON CONFLICT (activity_type_id, valid_from)
                             DO UPDATE SET rate_cents = EXCLUDED.rate_cents""",
                        (type_id, has_rows, body.rate_cents))
        auth.audit(conn, "ledger", "Type rate set", f"type:{type_id}",
                   f"{body.rate_cents}c/h from today ({who['label']})")
        return {"ok": True}


class DefaultRate(BaseModel):
    rate_cents: int | None = None      # None = unset from today (dated row; falls through the ladder)


@router.put("/api/default-rates/{type_id}")
def put_default_rate(type_id: str, body: DefaultRate, request: Request):
    """Global default rate per activity type — effective-dated; a client
    prices from it only while its 'use global default rates' switch is on
    and the type isn't toggled off. First-ever row anchors at epoch (same
    reason as put_type_rate: never price pre-existing time at $0)."""
    if body.rate_cents is not None and body.rate_cents < 0:
        raise HTTPException(422, "rate_cents must be >= 0")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_manage_types", "l_manage_settings")
        with conn.cursor() as cur:
            cur.execute("SELECT is_sentinel FROM ledger.activity_types WHERE id::text = %s",
                        (type_id,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such activity type")
            if row[0]:
                raise HTTPException(422, "The Unclassified sentinel never prices")
            cur.execute("SELECT EXISTS (SELECT 1 FROM ledger.default_rates "
                        "WHERE activity_type_id = %s)", (type_id,))
            (has_rows,) = cur.fetchone()
            cur.execute("""INSERT INTO ledger.default_rates
                             (activity_type_id, valid_from, rate_cents)
                           VALUES (%s, CASE WHEN %s THEN current_date
                                            ELSE '1970-01-01'::date END, %s)
                           ON CONFLICT (activity_type_id, valid_from)
                             DO UPDATE SET rate_cents = EXCLUDED.rate_cents""",
                        (type_id, has_rows, body.rate_cents))
        auth.audit(conn, "ledger", "Default rate set", f"type:{type_id}",
                   f"global default {body.rate_cents if body.rate_cents is not None else 'unset'}c/h "
                   f"from today ({who['label']})")
        return {"ok": True}


class ClientRate(BaseModel):
    activity_type: str | None = None   # uuid; None = client-wide override
    rate_cents: int | None = None      # None = inherit (clears the override)
    billable: bool | None = None       # None = inherit


@router.put("/api/clients/{client_id}/rates")
def put_client_rate(client_id: str, body: ClientRate, request: Request):
    """Per-client (and per-client-type) pricing overrides, effective today.
    NULLs mean inherit — an all-NULL row IS the reset, history intact."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_manage_clients")
        with conn.cursor() as cur:
            if body.activity_type is None:
                # 0038: the wide row's billable IS the client's billable-by-
                # default veto — a same-day rate edit (which sends billable
                # NULL) must PRESERVE it, never null it out. Explicit values
                # still win; only the typed lane keeps NULL-means-reset for
                # billable (clearClientTypeOverride relies on it).
                cur.execute("""INSERT INTO ledger.client_rates
                                 (client_id, activity_type_id, valid_from, rate_cents, billable)
                               VALUES (%s, NULL, current_date, %s, %s)
                               ON CONFLICT (client_id, valid_from) WHERE activity_type_id IS NULL
                                 DO UPDATE SET rate_cents = EXCLUDED.rate_cents,
                                               billable = COALESCE(EXCLUDED.billable,
                                                                   ledger.client_rates.billable)""",
                            (client_id, body.rate_cents, body.billable))
            else:
                cur.execute("""INSERT INTO ledger.client_rates
                                 (client_id, activity_type_id, valid_from, rate_cents, billable)
                               VALUES (%s, %s, current_date, %s, %s)
                               ON CONFLICT (client_id, valid_from, activity_type_id)
                                 WHERE activity_type_id IS NOT NULL
                                 DO UPDATE SET rate_cents = EXCLUDED.rate_cents,
                                               billable = EXCLUDED.billable""",
                            (client_id, body.activity_type, body.rate_cents, body.billable))
        auth.audit(conn, "ledger", "Client rate override", f"client:{client_id}",
                   (f"type {body.activity_type}" if body.activity_type else "client-wide")
                   + f" · rate {body.rate_cents if body.rate_cents is not None else 'inherit'}"
                   + f" · billable {body.billable if body.billable is not None else 'inherit'}")
        return {"ok": True}


class ClientDefaultOptin(BaseModel):
    activity_type: str | None = None   # uuid; None = the client-wide switch
    enabled: bool


@router.put("/api/clients/{client_id}/default-rates")
def put_client_default_optin(client_id: str, body: ClientDefaultOptin, request: Request):
    """Effective-dated opt-in flags: the wide row is the 'use global default
    rates' switch (off until a row says on); a typed row toggles ONE work
    type out of / back into inheriting (absent = inherits while the switch
    is on). Dated rows mean a flip today never re-prices yesterday."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_manage_clients")
        with conn.cursor() as cur:
            if body.activity_type is None:
                cur.execute("""INSERT INTO ledger.client_default_rate_optin
                                 (client_id, activity_type_id, valid_from, enabled)
                               VALUES (%s, NULL, current_date, %s)
                               ON CONFLICT (client_id, valid_from) WHERE activity_type_id IS NULL
                                 DO UPDATE SET enabled = EXCLUDED.enabled""",
                            (client_id, body.enabled))
            else:
                cur.execute("""INSERT INTO ledger.client_default_rate_optin
                                 (client_id, activity_type_id, valid_from, enabled)
                               VALUES (%s, %s, current_date, %s)
                               ON CONFLICT (client_id, valid_from, activity_type_id)
                                 WHERE activity_type_id IS NOT NULL
                                 DO UPDATE SET enabled = EXCLUDED.enabled""",
                            (client_id, body.activity_type, body.enabled))
        auth.audit(conn, "ledger", "Client default-rates flag", f"client:{client_id}",
                   (f"type {body.activity_type}" if body.activity_type else "use-defaults switch")
                   + f" → {'on' if body.enabled else 'off'} ({who['label']})")
        return {"ok": True}


class ClientAccess(BaseModel):
    mode: str                          # all | restricted | group
    techs: list[str] = []
    groups: list[str] = []


class ClientRetainer(BaseModel):
    enabled: bool = True
    included_hours: float = 0
    overage_rate_cents: int | None = None   # None = overage bills at standard rates
    rollover_cap_hours: float = 0
    note: str = ""


@router.put("/api/clients/{client_id}/retainer")
def put_client_retainer(client_id: str, body: ClientRetainer, request: Request):
    """The retainer/block-hours agreement (0043) — the editor was UI-local
    until the audit; terms now survive the hydrate like everything else."""
    if body.included_hours < 0 or body.rollover_cap_hours < 0 \
            or (body.overage_rate_cents is not None and body.overage_rate_cents < 0):
        raise HTTPException(422, "Hours and rates cannot be negative")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_manage_clients")
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO ledger.retainers
                             (client_id, included_hours, overage_rate_cents,
                              rollover_cap_hours, enabled, note)
                           VALUES (%s, %s, %s, %s, %s, %s)
                           ON CONFLICT (client_id) DO UPDATE
                             SET included_hours = EXCLUDED.included_hours,
                                 overage_rate_cents = EXCLUDED.overage_rate_cents,
                                 rollover_cap_hours = EXCLUDED.rollover_cap_hours,
                                 enabled = EXCLUDED.enabled,
                                 note = EXCLUDED.note""",
                        (client_id, body.included_hours, body.overage_rate_cents,
                         body.rollover_cap_hours, body.enabled, body.note))
        auth.audit(conn, "ledger", "Retainer agreement changed", f"client:{client_id}",
                   (f"{'active' if body.enabled else 'off'} · {body.included_hours} h included · "
                    + ("standard overage rates" if body.overage_rate_cents is None
                       else f"overage {body.overage_rate_cents}¢/h")
                    + f" · rollover cap {body.rollover_cap_hours} h ({who['label']})"))
        return {"ok": True}


@router.put("/api/clients/{client_id}/access")
def put_client_access(client_id: str, body: ClientAccess, request: Request):
    if body.mode not in ("all", "restricted", "group"):
        raise HTTPException(422, "mode must be all, restricted, or group")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "l_manage_clients")
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO ledger.client_access
                             (client_id, mode, tech_ids, group_ids)
                           VALUES (%s, %s, %s::uuid[], %s::uuid[])
                           ON CONFLICT (client_id) DO UPDATE
                             SET mode = EXCLUDED.mode, tech_ids = EXCLUDED.tech_ids,
                                 group_ids = EXCLUDED.group_ids""",
                        (client_id, body.mode, body.techs, body.groups))
        auth.audit(conn, "ledger", "Client access changed", f"client:{client_id}",
                   f"{body.mode} · {len(body.techs)} techs · {len(body.groups)} groups")
        return {"ok": True}
