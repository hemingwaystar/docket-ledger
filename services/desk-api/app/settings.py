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
import httpx
from fastapi import APIRouter, HTTPException, Request
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
                              paused, outbound)
                           VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
                        (body.address.lower().strip(), body.display_name, gid, pid,
                         body.paused, body.outbound))
            (mid,) = cur.fetchone()
        auth.audit(conn, "desk", "Mailbox added", f"mailbox:{mid}",
                   f"{body.address} → {body.group} ({who['label']})")
        return {"id": str(mid)}


class PatchMailbox(BaseModel):
    paused: bool | None = None
    outbound: bool | None = None
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
