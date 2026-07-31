"""Settings — the GUI-configurable control plane (§7): every operational
switch lives in shared.app_config; credentials live envelope-encrypted in
shared.secrets behind a WRITE-ONLY api (metadata out, never plaintext).

Graph connection flow (single-tenant, application permissions):
  1. In Entra: app registration with Mail.Read + Mail.Send (Application),
     admin consent granted.
  2. PUT /api/settings/config/graph        {tenant, client_id, ...}
  3. PUT /api/settings/secrets/graph       {value: "<client secret>"}
  4. POST /api/settings/graph/test         → acquires a real token; on success
     flips graph.connected = true and the mail-worker starts ingesting within
     one scheduler pass.
"""
import json
import uuid as uuid_lib
import httpx
from typing import Literal
from fastapi import APIRouter, HTTPException, Request
from psycopg import errors as pg_errors
from psycopg.rows import dict_row
from pydantic import BaseModel
from . import auth, crypto, db, helpers, mailer

router = APIRouter(prefix="/api/settings")

CONFIG_KEYS = ("auth", "graph", "mail", "verification", "business_hours",
               "odoo", "retainers", "projects", "sla")


@router.get("/config")
def all_config(request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings", "manage_automations")
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT key, value, updated_at, updated_by FROM shared.app_config "
                        "ORDER BY key")
            return {"config": cur.fetchall()}


class ConfigValue(BaseModel):
    value: dict


@router.put("/config/{key}")
def put_config(key: str, body: ConfigValue, request: Request):
    if key not in CONFIG_KEYS:
        raise HTTPException(422, f"Unknown config key — one of {', '.join(CONFIG_KEYS)}")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings", "manage_automations")
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO shared.app_config (key, value)
                           VALUES (%s, %s)
                           ON CONFLICT (key) DO UPDATE
                             SET value = EXCLUDED.value, updated_at = now(),
                                 updated_by = shared.current_actor(),
                                 version = shared.app_config.version + 1""",
                        (key, json.dumps(body.value)))
        auth.audit(conn, "desk", "Settings changed", f"config:{key}",
                   f"{key} updated by {who['label']}")
        return {"ok": True}


@router.get("/secrets")
def list_secrets(request: Request):
    """Metadata only — name, when, which KEK. Plaintext never leaves."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT name, kek_id, rotated_at, rotated_by FROM shared.secrets "
                        "ORDER BY name")
            return {"secrets": cur.fetchall()}


class SecretValue(BaseModel):
    value: str


@router.put("/secrets/{name}")
def put_secret(name: str, body: SecretValue, request: Request):
    if name not in ("graph", "entra_oidc", "voipms", "twilio", "odoo"):
        raise HTTPException(422, "Unknown secret name")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        blob = crypto.seal(body.value.encode())
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO shared.secrets (name, ciphertext, nonce, kek_id)
                           VALUES (%s, %s, ''::bytea, 'kek-file-1')
                           ON CONFLICT (name) DO UPDATE
                             SET ciphertext = EXCLUDED.ciphertext,
                                 rotated_at = now(),
                                 rotated_by = shared.current_actor()""",
                        (name, blob))
        auth.audit(conn, "auth", "Secret rotated", f"secret:{name}",
                   f"{name} stored (envelope-encrypted) by {who['label']} — value not logged")
        return {"ok": True}


def _graph_token(cur) -> tuple[str, str]:
    """Client-credentials token. Returns (token, tenant). Raises 409 with a
    human reason when config/secret/consent is missing or wrong."""
    cur.execute("SELECT value FROM shared.app_config WHERE key = 'graph'")
    row = cur.fetchone()
    cfg = row[0] if row else {}
    if isinstance(cfg, str):
        cfg = json.loads(cfg)
    tenant, client_id = cfg.get("tenant", ""), cfg.get("client_id", "")
    if not tenant or not client_id:
        raise HTTPException(409, "Set tenant and client_id in config/graph first")
    cur.execute("SELECT ciphertext FROM shared.secrets WHERE name = 'graph'")
    row = cur.fetchone()
    if row is None:
        raise HTTPException(409, "Store the client secret at secrets/graph first")
    secret = crypto.open_(row[0]).decode()
    resp = httpx.post(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data={"grant_type": "client_credentials", "client_id": client_id,
              "client_secret": secret,
              "scope": "https://graph.microsoft.com/.default"},
        timeout=15)
    if resp.status_code != 200:
        detail = resp.json().get("error_description", resp.text)[:300]
        raise HTTPException(409, f"Entra rejected the credentials: {detail}")
    return resp.json()["access_token"], tenant


@router.post("/graph/test")
def graph_test(request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        with conn.cursor() as cur:
            token, tenant = _graph_token(cur)
            cur.execute("""UPDATE shared.app_config
                              SET value = jsonb_set(value, '{connected}', 'true'),
                                  updated_at = now()
                            WHERE key = 'graph'""")
        auth.audit(conn, "desk", "Graph connected", "config:graph",
                   f"token acquired for tenant {tenant} — ingestion enabled ({who['label']})")
        return {"ok": True, "connected": True,
                "note": "mail-worker starts polling within one scheduler pass"}


class TestSend(BaseModel):
    to: str
    sender: str | None = None          # defaults to first unpaused outbound mailbox


@router.post("/graph/test-send")
def graph_test_send(body: TestSend, request: Request):
    """Outbound pre-flight. graph/test only proves the token (secret, tenant,
    app id); Mail.Send consent and the application access policy only fail on
    a REAL send — this sends one plain test message through the exact mailer
    path agent replies use, so those failures surface here with Graph's own
    error, BEFORE the go-live flip. Deliberately not gated on
    mail.outbound_enabled: an explicit admin action to a self-chosen address
    is pre-flight, not customer-touching mail. No ticket or article is
    created. Test verify@ by passing it as sender."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        with conn.cursor() as cur:
            sender = (body.sender or "").strip().lower()
            if not sender:
                cur.execute("""SELECT address FROM desk.mailboxes
                                WHERE NOT paused AND outbound
                                ORDER BY address LIMIT 1""")
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(409, "No unpaused outbound-eligible "
                                             "mailbox — pass one as 'sender'")
                sender = row[0]
            mid = mailer.send_reply(
                cur, mailbox_address=sender, display_name="Docket",
                to=body.to.strip(), cc=[],
                subject="Docket outbound test",
                body="This is Docket's outbound pre-flight test.\n\n"
                     "Receiving it proves the Graph secret and tenant are "
                     "right, Mail.Send is consented, and this sender is in "
                     "the application access policy. No ticket was created.",
                in_reply_to=None, references=[])
        auth.audit(conn, "desk", "Outbound test sent", "config:graph",
                   f"test mail {sender} → {body.to.strip()} ({who['label']})")
        return {"ok": True, "sent_from": sender, "message_id": mid}


class OutboundFlip(BaseModel):
    enabled: bool


@router.post("/mail/outbound")
def set_outbound(body: OutboundFlip, request: Request):
    """The go-live master switch, as an endpoint so the UI control can
    mirror it. jsonb_set on the one key — never clobbers the rest of the
    mail config. Read per-request by both send paths: effective immediately,
    no restart."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings", "manage_automations")
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO shared.app_config (key, value)
                           VALUES ('mail', jsonb_build_object('outbound_enabled', %s::boolean))
                           ON CONFLICT (key) DO UPDATE
                             SET value = jsonb_set(coalesce(shared.app_config.value,'{}'::jsonb),
                                                   '{outbound_enabled}', to_jsonb(%s::boolean)),
                                 updated_at = now(),
                                 updated_by = shared.current_actor(),
                                 version = shared.app_config.version + 1""",
                        (body.enabled, body.enabled))
        auth.audit(conn, "desk",
                   "Outbound sending enabled" if body.enabled else "Outbound sending disabled",
                   "config:mail",
                   ("LIVE — agent replies and trigger emails now send"
                    if body.enabled else "recorded-only — replies stored, nothing sends")
                   + f" ({who['label']})")
        return {"ok": True, "outbound_enabled": body.enabled}


@router.post("/graph/disconnect")
def graph_disconnect(request: Request):
    """Flip only the connected flag (jsonb_set — never clobbers the rest of
    the graph config). The worker idles on its next pass; mailboxes stop."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        with conn.cursor() as cur:
            cur.execute("""UPDATE shared.app_config
                              SET value = jsonb_set(value, '{connected}', 'false'),
                                  updated_at = now()
                            WHERE key = 'graph'""")
        auth.audit(conn, "desk", "Graph disconnected", "config:graph",
                   f"ingestion + sending paused ({who['label']})")
        return {"ok": True, "connected": False}


@router.get("/mailboxes")
def list_mailboxes(request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings", "manage_automations")
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""SELECT m.id, m.address, m.display_name, g.name AS "group",
                                  p.label AS default_priority, m.paused, m.outbound,
                                  m.mailbox_type AS type,
                                  gs.last_delta_at
                             FROM desk.mailboxes m
                             JOIN shared.groups g ON g.id = m.group_id
                             LEFT JOIN desk.priorities p ON p.id = m.default_priority_id
                             LEFT JOIN desk.graph_subscriptions gs ON gs.mailbox_id = m.id
                            ORDER BY m.address""")
            return {"mailboxes": cur.fetchall()}


class NewMailbox(BaseModel):
    address: str
    outbound: bool = True
    type: Literal["shared", "licensed"] = "shared"
    group: str
    display_name: str = ""
    default_priority: str | None = None
    paused: bool = False


@router.post("/mailboxes", status_code=201)
def create_mailbox(body: NewMailbox, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings", "manage_automations")
        with conn.cursor() as cur:
            gid = helpers.group_id(cur, body.group)
            pid = helpers.priority_id(cur, body.default_priority) if body.default_priority else None
            cur.execute("""INSERT INTO desk.mailboxes
                             (address, display_name, group_id, default_priority_id,
                              paused, outbound, mailbox_type)
                           VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                        (body.address.lower().strip(), body.display_name, gid, pid,
                         body.paused, body.outbound, body.type))
            (mid,) = cur.fetchone()
        auth.audit(conn, "desk", "Mailbox added", f"mailbox:{mid}",
                   f"{body.address} → {body.group} ({who['label']})")
        return {"id": str(mid)}


class PatchMailbox(BaseModel):
    paused: bool | None = None
    outbound: bool | None = None
    type: Literal["shared", "licensed"] | None = None
    group: str | None = None
    address: str | None = None         # rename — path param is the OLD address
    display_name: str | None = None
    default_priority: str | None = None


@router.patch("/mailboxes/{address}")
def patch_mailbox(address: str, body: PatchMailbox, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings", "manage_automations")
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM desk.mailboxes WHERE lower(address) = lower(%s)",
                        (address,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such mailbox")
            (mid,) = row
            notes = []
            if body.paused is not None:
                cur.execute("UPDATE desk.mailboxes SET paused = %s WHERE id = %s",
                            (body.paused, mid))
                notes.append("paused" if body.paused else "resumed")
            if body.outbound is not None:
                cur.execute("UPDATE desk.mailboxes SET outbound = %s WHERE id = %s",
                            (body.outbound, mid))
                notes.append("send-eligible" if body.outbound else "receive-only")
            if body.type is not None:
                cur.execute("UPDATE desk.mailboxes SET mailbox_type = %s WHERE id = %s",
                            (body.type, mid))
                notes.append(f"type → {body.type}")
            if body.address is not None:
                cur.execute("UPDATE desk.mailboxes SET address = %s WHERE id = %s",
                            (body.address.lower().strip(), mid))
                notes.append(f"address → {body.address}")
            if body.display_name is not None:
                cur.execute("UPDATE desk.mailboxes SET display_name = %s WHERE id = %s",
                            (body.display_name, mid))
                notes.append("display name set")
            if body.default_priority is not None:
                pid = helpers.priority_id(cur, body.default_priority)
                cur.execute("UPDATE desk.mailboxes SET default_priority_id = %s WHERE id = %s",
                            (pid, mid))
                notes.append(f"priority → {body.default_priority}")
            if body.group is not None:
                cur.execute("UPDATE desk.mailboxes SET group_id = %s WHERE id = %s",
                            (helpers.group_id(cur, body.group), mid))
                notes.append(f"group → {body.group}")
        if notes:
            auth.audit(conn, "desk", "Mailbox updated", f"mailbox:{mid}",
                       f"{address} · " + " · ".join(notes))
        return {"ok": True}


class NewCanned(BaseModel):
    name: str
    body: str


class PatchCanned(BaseModel):
    name: str | None = None
    body: str | None = None
    active: bool | None = None         # false = archived, never deleted (0014)


@router.post("/canned", status_code=201)
def create_canned(body: NewCanned, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings", "manage_automations")
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO desk.canned_responses (name, body)
                           VALUES (%s, %s) RETURNING id""", (body.name, body.body))
            (cid,) = cur.fetchone()
        auth.audit(conn, "desk", "Canned response added", f"canned:{cid}", body.name)
        return {"id": str(cid)}


@router.patch("/canned/{canned_id}")
def patch_canned(canned_id: str, body: PatchCanned, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings", "manage_automations")
        cols = {k: v for k, v in body.model_dump().items() if v is not None}
        if not cols:
            return {"ok": True}
        with conn.cursor() as cur:
            sets = ", ".join(f"{k} = %s" for k in cols)
            cur.execute(f"UPDATE desk.canned_responses SET {sets} WHERE id = %s RETURNING name",
                        (*cols.values(), canned_id))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such canned response")
        auth.audit(conn, "desk", "Canned response updated", f"canned:{canned_id}",
                   f"{row[0]} · " + ", ".join(cols))
        return {"ok": True}


def _uuid_or_404(value: str, what: str) -> str:
    try:
        uuid_lib.UUID(value)
        return value
    except ValueError:
        raise HTTPException(404, f"No such {what}")


class NewState(BaseModel):
    label: str
    kind: Literal["open", "paused", "done"]


class PatchState(BaseModel):
    label: str | None = None
    active: bool | None = None         # false = archived, never deleted
    position: int | None = None
    # kind is immutable after create — it drives SLA/pending/reports


@router.post("/states", status_code=201)
def create_state(body: NewState, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        with conn.cursor() as cur:
            try:
                cur.execute("""INSERT INTO desk.ticket_states (label, kind, position)
                               SELECT %s, %s, coalesce(max(position), 0) + 1
                                 FROM desk.ticket_states
                               RETURNING id, active, position""",
                            (body.label, body.kind))
            except pg_errors.UniqueViolation:
                raise HTTPException(409, f"A state named “{body.label}” already exists")
            (sid, active, position) = cur.fetchone()
        auth.audit(conn, "desk", "Ticket state added", f"state:{sid}",
                   f"{body.label} ({body.kind})")
        return {"id": str(sid), "label": body.label, "kind": body.kind,
                "active": active, "position": position}


@router.patch("/states/{state_id}")
def patch_state(state_id: str, body: PatchState, request: Request):
    _uuid_or_404(state_id, "state")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        with conn.cursor() as cur:
            cur.execute("""SELECT label, kind, active, position, is_system, is_core
                             FROM desk.ticket_states WHERE id = %s""", (state_id,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such state")
            if row[4]:
                raise HTTPException(422, f"“{row[0]}” is a system state — "
                                          "machine-written by the parent-close cascade; it can't be edited")
            cols = {k: v for k, v in body.model_dump().items() if v is not None}
            # core states keep their names: the mail pipeline resolves 'New'/'Open'
            # by label (worker.py) — archive/reorder is fine, rename is not
            if row[5] and "label" in cols and cols["label"] != row[0]:
                raise HTTPException(409, "Core states keep their names — add a custom state instead")
            if cols:
                sets = ", ".join(f"{k} = %s" for k in cols)
                try:
                    cur.execute(f"""UPDATE desk.ticket_states SET {sets} WHERE id = %s
                                    RETURNING label, kind, active, position""",
                                (*cols.values(), state_id))
                except pg_errors.UniqueViolation:
                    raise HTTPException(409, f"A state named “{cols.get('label')}” already exists")
                row = cur.fetchone()
        if cols:
            auth.audit(conn, "desk", "Ticket state updated", f"state:{state_id}",
                       f"{row[0]} · " + ", ".join(cols))
        return {"id": state_id, "label": row[0], "kind": row[1],
                "active": row[2], "position": row[3]}


class NewPriority(BaseModel):
    label: str
    rank: int


class PatchPriority(BaseModel):
    label: str | None = None
    rank: int | None = None
    active: bool | None = None         # false = archived, never deleted


@router.post("/priorities", status_code=201)
def create_priority(body: NewPriority, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        with conn.cursor() as cur:
            # sla_* columns are 0001 relics (SLA config lives in app_config, 0020)
            # but NOT NULL — filled with the seed's 'Normal' values, never surfaced
            try:
                cur.execute("""INSERT INTO desk.priorities
                                 (label, rank, sla_first_response_hours, sla_resolution_hours)
                               VALUES (%s, %s, 8, 48) RETURNING id, active""",
                            (body.label, body.rank))
            except pg_errors.UniqueViolation as e:
                if (e.diag.constraint_name or "").endswith("rank_key"):
                    raise HTTPException(409, f"Rank {body.rank} is taken — ranks are unique")
                raise HTTPException(409, f"A priority named “{body.label}” already exists")
            (pid, active) = cur.fetchone()
        auth.audit(conn, "desk", "Priority added", f"priority:{pid}",
                   f"{body.label} · rank {body.rank}")
        return {"id": str(pid), "label": body.label, "rank": body.rank,
                "active": active}


@router.patch("/priorities/{priority_id}")
def patch_priority(priority_id: str, body: PatchPriority, request: Request):
    _uuid_or_404(priority_id, "priority")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        with conn.cursor() as cur:
            cur.execute("""SELECT label, rank, active FROM desk.priorities
                            WHERE id = %s""", (priority_id,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such priority")
            cols = {k: v for k, v in body.model_dump().items() if v is not None}
            # 'Normal' is the ingestion fallback: the worker files unrouted mail
            # under it by label (worker.py) — it keeps its name
            if row[0] == "Normal" and cols.get("label") not in (None, "Normal"):
                raise HTTPException(409, "“Normal” is the ingestion fallback priority — it keeps its name")
            if cols:
                sets = ", ".join(f"{k} = %s" for k in cols)
                try:
                    cur.execute(f"""UPDATE desk.priorities SET {sets} WHERE id = %s
                                    RETURNING label, rank, active""",
                                (*cols.values(), priority_id))
                except pg_errors.UniqueViolation as e:
                    if (e.diag.constraint_name or "").endswith("rank_key"):
                        raise HTTPException(409, f"Rank {cols.get('rank')} is taken — ranks are unique")
                    raise HTTPException(409, f"A priority named “{cols.get('label')}” already exists")
                row = cur.fetchone()
        if cols:
            auth.audit(conn, "desk", "Priority updated", f"priority:{priority_id}",
                       f"{row[0]} · " + ", ".join(cols))
        return {"id": priority_id, "label": row[0], "rank": row[1], "active": row[2]}


@router.get("/tokens")
def list_tokens(request: Request):
    """Metadata only — name and timestamps; token material never leaves.
    No mint/revoke here: PATs stay operator-minted (scripts/create-token.sh)."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        ms = lambda dt: int(dt.timestamp() * 1000) if dt else None
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""SELECT label, created_at, last_used_at FROM shared.api_tokens
                            WHERE revoked_at IS NULL ORDER BY created_at DESC""")
            return {"tokens": [{"name": r["label"], "createdAt": ms(r["created_at"]),
                                "lastUsedAt": ms(r["last_used_at"])}
                               for r in cur.fetchall()]}
