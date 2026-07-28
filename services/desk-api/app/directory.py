"""Directory writes — the control plane the prototypes edited in Docket.
Archive-first everywhere; the DB refuses deletes and sentinel abuse."""
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from pydantic import BaseModel
from . import auth, db, helpers

router = APIRouter(prefix="/api/directory")


@router.get("")
def directory(request: Request):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor(row_factory=dict_row) as cur:
            out = {}
            cur.execute("SELECT id, name, active FROM shared.groups ORDER BY name")
            out["groups"] = cur.fetchall()
            cur.execute("""SELECT a.id, a.name, a.email, a.initials, a.active,
                                  r.name AS role,
                                  COALESCE((SELECT array_agg(g.name ORDER BY g.name)
                                             FROM shared.agent_groups ag
                                             JOIN shared.groups g ON g.id = ag.group_id
                                            WHERE ag.agent_id = a.id), '{}') AS groups
                             FROM shared.agents a
                             LEFT JOIN shared.roles r ON r.id = a.role_id
                            ORDER BY a.name""")
            out["agents"] = cur.fetchall()
            cur.execute("""SELECT c.id, c.name, c.is_sentinel, c.billing_cycle,
                                  c.billable_default, c.archived_at,
                                  COALESCE((SELECT array_agg(domain ORDER BY domain)
                                             FROM shared.client_domains d
                                            WHERE d.client_id = c.id), '{}') AS domains
                             FROM shared.clients c ORDER BY c.is_sentinel DESC, c.name""")
            out["clients"] = cur.fetchall()
            cur.execute("""SELECT r.id, r.name, r.note, r.is_core, r.entra_group,
                                  COALESCE((SELECT array_agg(permission_id ORDER BY permission_id)
                                             FROM shared.role_permissions rp
                                            WHERE rp.role_id = r.id), '{}') AS permissions
                             FROM shared.roles r WHERE r.active ORDER BY r.name""")
            out["roles"] = cur.fetchall()
            return out


class NewGroup(BaseModel):
    name: str


@router.post("/groups", status_code=201)
def create_group(body: NewGroup, request: Request):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor() as cur:
            cur.execute("INSERT INTO shared.groups (name) VALUES (%s) RETURNING id",
                        (body.name,))
            (gid,) = cur.fetchone()
        auth.audit(conn, "desk", "Group added", f"group:{gid}", body.name)
        return {"id": str(gid)}


class NewAgent(BaseModel):
    name: str
    email: str
    initials: str = ""
    role: str = "Technician"
    groups: list[str] = []


@router.post("/agents", status_code=201)
def create_agent(body: NewAgent, request: Request):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor() as cur:
            role = helpers.one(cur, "SELECT id FROM shared.roles WHERE name = %s AND active",
                               (body.role,), "Unknown role")[0]
            cur.execute("""INSERT INTO shared.agents (name, email, initials, role_id)
                           VALUES (%s, %s, %s, %s) RETURNING id""",
                        (body.name, body.email, body.initials, role))
            (aid,) = cur.fetchone()
            for g in body.groups:
                cur.execute("INSERT INTO shared.agent_groups (agent_id, group_id) VALUES (%s, %s)",
                            (aid, helpers.group_id(cur, g)))
        auth.audit(conn, "desk", "Agent added", f"agent:{aid}",
                   f"{body.name} <{body.email}> · role {body.role}")
        return {"id": str(aid)}


class PatchAgent(BaseModel):
    role: str | None = None            # manual assignment — authoritative when Entra mapping is off
    groups: list[str] | None = None
    active: bool | None = None


@router.patch("/agents/{email}")
def patch_agent(email: str, body: PatchAgent, request: Request):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor() as cur:
            aid, name = helpers.agent(cur, email)
            changes = []
            if body.role is not None:
                role = helpers.one(cur, "SELECT id FROM shared.roles WHERE name = %s AND active",
                                   (body.role,), "Unknown role")[0]
                cur.execute("UPDATE shared.agents SET role_id = %s WHERE id = %s", (role, aid))
                changes.append(f"role → {body.role}")
            if body.active is not None:
                cur.execute("UPDATE shared.agents SET active = %s WHERE id = %s",
                            (body.active, aid))
                changes.append("restored" if body.active else "deactivated")
            if body.groups is not None:
                cur.execute("DELETE FROM shared.agent_groups WHERE agent_id = %s", (aid,))
                for g in body.groups:
                    cur.execute("INSERT INTO shared.agent_groups (agent_id, group_id) VALUES (%s, %s)",
                                (aid, helpers.group_id(cur, g)))
                changes.append("groups → " + (", ".join(body.groups) or "—"))
        if changes:
            auth.audit(conn, "desk", "Agent updated", f"agent:{aid}",
                       f"{name} · " + " · ".join(changes))
        return {"ok": True}


class NewClient(BaseModel):
    name: str
    billing_cycle: str = "monthly"     # monthly | weekly
    billable_default: bool = True
    domains: list[str] = []


@router.post("/clients", status_code=201)
def create_client(body: NewClient, request: Request):
    if body.billing_cycle not in ("monthly", "weekly"):
        raise HTTPException(422, "billing_cycle must be monthly or weekly")
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO shared.clients (name, billing_cycle, billable_default)
                           VALUES (%s, %s, %s) RETURNING id""",
                        (body.name, body.billing_cycle, body.billable_default))
            (cid,) = cur.fetchone()
            for d in body.domains:
                cur.execute("INSERT INTO shared.client_domains (client_id, domain) VALUES (%s, %s)",
                            (cid, d.lower().strip()))
        auth.audit(conn, "desk", "Client added", f"client:{cid}",
                   f"{body.name} · {body.billing_cycle}"
                   + (f" · domains {', '.join(body.domains)}" if body.domains else ""))
        return {"id": str(cid)}


class PatchClient(BaseModel):
    archived: bool | None = None       # archive-first; DB refuses on the sentinel
    domains: list[str] | None = None


@router.patch("/clients/{handle}")
def patch_client(handle: str, body: PatchClient, request: Request):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor() as cur:
            cid = helpers.client_id(cur, handle)
            if body.archived is not None:
                cur.execute(
                    "UPDATE shared.clients SET archived_at = CASE WHEN %s THEN now() END WHERE id = %s",
                    (body.archived, cid))
                auth.audit(conn, "desk",
                           "Client archived" if body.archived else "Client restored",
                           f"client:{cid}", handle)
            if body.domains is not None:
                cur.execute("DELETE FROM shared.client_domains WHERE client_id = %s", (cid,))
                for d in body.domains:
                    cur.execute("INSERT INTO shared.client_domains (client_id, domain) VALUES (%s, %s)",
                                (cid, d.lower().strip()))
                auth.audit(conn, "desk", "Client domains updated", f"client:{cid}",
                           ", ".join(body.domains) or "—")
        return {"ok": True}


class NewContact(BaseModel):
    client: str
    name: str
    email: str
    title: str = ""
    department: str = ""
    phone: str = ""
    mobile: str = ""


@router.post("/contacts", status_code=201)
def create_contact(body: NewContact, request: Request):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor() as cur:
            cid = helpers.client_id(cur, body.client)
            cur.execute("""INSERT INTO shared.contacts
                             (client_id, name, email, title, department, phone, mobile)
                           VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                        (cid, body.name, body.email, body.title, body.department,
                         body.phone, body.mobile))
            (pid,) = cur.fetchone()
        auth.audit(conn, "desk", "Contact added", f"contact:{pid}",
                   f"{body.name} <{body.email}> → {body.client}")
        return {"id": str(pid)}
