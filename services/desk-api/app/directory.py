"""Directory writes — the control plane the prototypes edited in Docket.
Archive-first everywhere; the DB refuses deletes and sentinel abuse — with
one user-approved exception: guarded role hard-delete (0030)."""
import json
from fastapi import APIRouter, HTTPException, Request
from psycopg import errors as pg_errors
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
            cur.execute("""SELECT r.id, r.name, r.note, r.is_core, r.entra_group, r.active,
                                  COALESCE((SELECT array_agg(permission_id ORDER BY permission_id)
                                             FROM shared.role_permissions rp
                                            WHERE rp.role_id = r.id), '{}') AS permissions
                             FROM shared.roles r ORDER BY r.name""")
            out["roles"] = cur.fetchall()
            return out


class NewGroup(BaseModel):
    name: str


@router.post("/groups", status_code=201)
def create_group(body: NewGroup, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_settings')
        with conn.cursor() as cur:
            cur.execute("INSERT INTO shared.groups (name) VALUES (%s) RETURNING id",
                        (body.name,))
            (gid,) = cur.fetchone()
        auth.audit(conn, "desk", "Group added", f"group:{gid}", body.name)
        return {"id": str(gid)}


class PatchGroup(BaseModel):
    name: str | None = None
    active: bool | None = None         # archive-first; archiving pauses its mailboxes


@router.patch("/groups/{handle}")
def patch_group(handle: str, body: PatchGroup, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_settings', 'manage_roles')
        with conn.cursor() as cur:
            gid = helpers.group_id(cur, handle)
            changes = []
            if body.name is not None:
                cur.execute("UPDATE shared.groups SET name = %s WHERE id = %s",
                            (body.name, gid))
                changes.append(f"renamed → {body.name}")
            if body.active is not None:
                if not body.active:
                    cur.execute("SELECT count(*) FROM shared.groups WHERE active AND id <> %s",
                                (gid,))
                    if cur.fetchone()[0] == 0:
                        raise HTTPException(409, "At least one group has to stay active")
                cur.execute("UPDATE shared.groups SET active = %s WHERE id = %s",
                            (body.active, gid))
                if not body.active:   # archived groups stop receiving mail
                    cur.execute("""UPDATE desk.mailboxes SET paused = true
                                    WHERE group_id = %s AND NOT paused
                                   RETURNING address""", (gid,))
                    paused = [r[0] for r in cur.fetchall()]
                    changes.append("archived" + (f" · paused {', '.join(paused)}" if paused else ""))
                else:
                    changes.append("restored (resume its mailboxes when ready)")
        if changes:
            auth.audit(conn, "desk", "Group updated", f"group:{gid}",
                       f"{handle} · " + " · ".join(changes))
        return {"ok": True}


class NewAgent(BaseModel):
    name: str
    email: str
    initials: str = ""
    role: str = "Technician"
    groups: list[str] = []


@router.post("/agents", status_code=201)
def create_agent(body: NewAgent, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_roles', 'manage_settings')
        with conn.cursor() as cur:
            role = helpers.one(cur, "SELECT id FROM shared.roles WHERE name = %s AND active",
                               (body.role,), "Unknown role")[0]
            cur.execute("SELECT id, active FROM shared.agents WHERE lower(email) = lower(%s)",
                        (body.email,))
            row = cur.fetchone()
            if row and row[1]:
                raise HTTPException(409, "That email is already an active agent")
            revived = bool(row)
            if row:
                # deactivated agent — adding the same email REVIVES it with
                # the new details (email is UNIQUE; no-DELETE means the row
                # is still there, history intact)
                (aid, _) = row
                cur.execute("""UPDATE shared.agents
                                  SET active = true, name = %s, initials = left(%s, 3),
                                      role_id = %s WHERE id = %s""",
                            (body.name, body.initials, role, aid))
                cur.execute("DELETE FROM shared.agent_groups WHERE agent_id = %s", (aid,))
            else:
                # initials render inside avatar markup — the UI's maxlength=3
                # is cosmetic, the cap is enforced here
                cur.execute("""INSERT INTO shared.agents (name, email, initials, role_id)
                               VALUES (%s, %s, left(%s, 3), %s) RETURNING id""",
                            (body.name, body.email, body.initials, role))
                (aid,) = cur.fetchone()
            for g in body.groups:
                cur.execute("INSERT INTO shared.agent_groups (agent_id, group_id) VALUES (%s, %s)",
                            (aid, helpers.group_id(cur, g)))
        auth.audit(conn, "desk", "Agent reactivated" if revived else "Agent added",
                   f"agent:{aid}",
                   f"{body.name} <{body.email}> · role {body.role}"
                   + (" · revived with fresh details" if revived else ""))
        return {"id": str(aid)}


class PatchAgent(BaseModel):
    role: str | None = None            # manual assignment — authoritative when Entra mapping is off
    groups: list[str] | None = None
    active: bool | None = None


@router.patch("/agents/{email}")
def patch_agent(email: str, body: PatchAgent, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_roles', 'manage_settings')
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
    profile: dict = {}                 # display-only directory fields (0010)


@router.post("/clients", status_code=201)
def create_client(body: NewClient, request: Request):
    if body.billing_cycle not in ("monthly", "weekly"):
        raise HTTPException(422, "billing_cycle must be monthly or weekly")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_clients')
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO shared.clients (name, billing_cycle, billable_default, profile)
                           VALUES (%s, %s, %s, %s::jsonb) RETURNING id""",
                        (body.name, body.billing_cycle, body.billable_default,
                         json.dumps(body.profile)))
            (cid,) = cur.fetchone()
            if not body.billable_default:
                # 0038: pricing reads the dated wide client_rates lane, not the
                # column — a client born unticked must seed its veto row or the
                # card would say "No" while its time bills (INSERT grant: 0038;
                # a brand-new client has no same-day wide row to conflict with)
                cur.execute("""INSERT INTO ledger.client_rates
                                 (client_id, activity_type_id, valid_from, rate_cents, billable)
                               VALUES (%s, NULL, current_date, NULL, false)""", (cid,))
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
    name: str | None = None
    profile: dict | None = None        # replaces the whole profile (0010)


@router.patch("/clients/{handle}")
def patch_client(handle: str, body: PatchClient, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_clients')
        with conn.cursor() as cur:
            cid = helpers.client_id(cur, handle)
            if body.name is not None:
                cur.execute("UPDATE shared.clients SET name = %s WHERE id = %s",
                            (body.name, cid))
                auth.audit(conn, "desk", "Client renamed", f"client:{cid}", body.name)
            if body.profile is not None:
                cur.execute("UPDATE shared.clients SET profile = %s::jsonb WHERE id = %s",
                            (json.dumps(body.profile), cid))
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
    vip: bool = False                  # ★ chip + trigger condition (0028)
    pref: str = "email"                # preferred contact channel (0041)
    fax: str = ""
    notes: str = ""                    # "anything the next tech should know"


@router.post("/contacts", status_code=201)
def create_contact(body: NewContact, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'add_contacts', 'manage_clients')
        with conn.cursor() as cur:
            cid = helpers.client_id(cur, body.client)
            cur.execute("""INSERT INTO shared.contacts
                             (client_id, name, email, title, department, phone, mobile,
                              vip, pref, fax, notes)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                           RETURNING id""",
                        (cid, body.name, body.email, body.title, body.department,
                         body.phone, body.mobile, body.vip,
                         body.pref if body.pref in ("email", "sms", "phone", "fax")
                         else "email", body.fax, body.notes))
            (pid,) = cur.fetchone()
        auth.audit(conn, "desk", "Contact added", f"contact:{pid}",
                   f"{body.name} <{body.email}> → {body.client}"
                   + (" · VIP" if body.vip else ""))
        return {"id": str(pid)}


class PatchContact(BaseModel):
    name: str | None = None
    email: str | None = None
    title: str | None = None
    department: str | None = None
    phone: str | None = None
    mobile: str | None = None
    active: bool | None = None         # people leave — they stay on old tickets
    vip: bool | None = None            # omitted = unchanged; triggers key on it (0028)
    pref: str | None = None            # 0041 — the DB CHECK constrains values
    fax: str | None = None
    notes: str | None = None


@router.patch("/contacts/{contact_id}")
def patch_contact(contact_id: str, body: PatchContact, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'add_contacts', 'manage_clients')
        cols = {k: v for k, v in body.model_dump().items() if v is not None}
        if not cols:
            return {"ok": True}
        with conn.cursor() as cur:
            sets = ", ".join(f"{k} = %s" for k in cols)
            cur.execute(f"UPDATE shared.contacts SET {sets} WHERE id = %s RETURNING name",
                        (*cols.values(), contact_id))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such contact")
        auth.audit(conn, "desk", "Contact updated", f"contact:{contact_id}",
                   f"{row[0]} · " + ", ".join(
                       ("now VIP" if v else "no longer VIP") if k == "vip" else k
                       for k, v in cols.items()))
        return {"ok": True}


class NewRole(BaseModel):
    name: str
    note: str = ""


@router.post("/roles", status_code=201)
def create_role(body: NewRole, request: Request):
    """Custom role, no permissions yet — grant them with PATCH add[]."""
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "The role needs a name")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_roles")
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM shared.roles WHERE lower(name) = lower(%s)", (name,))
            if cur.fetchone():
                raise HTTPException(409, f"A role named “{name}” already exists")
            cur.execute("""INSERT INTO shared.roles (name, note)
                           VALUES (%s, %s) RETURNING id""", (name, body.note))
            (rid,) = cur.fetchone()
        auth.audit(conn, "desk", "Role created", f"role:{rid}",
                   f"{name} · by {who['label']} — grant permissions to make it useful")
        return {"id": str(rid)}


class PatchRole(BaseModel):
    note: str | None = None
    rename: str | None = None          # new role name (custom roles only)
    entra_group: str | None = None     # "" clears
    add: list[str] = []                # permission ids to grant
    remove: list[str] = []             # permission ids to revoke
    active: bool | None = None         # archive/restore — custom roles only; archived = hidden from pickers, holders keep it


@router.patch("/roles/{name}")
def patch_role(name: str, body: PatchRole, request: Request):
    """Role edits — permissions replace-style (0017 grants the DELETE), note,
    Entra group mapping, and archive/restore via `active` (custom roles only).
    Sessions snapshot perms at sign-in, so changes take effect on each agent's
    next login — stated in the audit line."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, 'manage_roles')
        with conn.cursor() as cur:
            # no active filter — restore has to be able to find an archived role
            cur.execute("SELECT id, is_core, active FROM shared.roles WHERE name = %s",
                        (name,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "Unknown role")
            rid, is_core, is_active = row
            changes = []
            if body.rename is not None and body.rename.strip() and body.rename != name:
                # agents reference role_id, so a rename never breaks membership;
                # core roles keep their names — bootstrap and docs key on them
                if is_core:
                    raise HTTPException(409, "Core roles keep their names — add a custom role instead")
                new = body.rename.strip()
                cur.execute("SELECT 1 FROM shared.roles WHERE name = %s", (new,))
                if cur.fetchone():
                    raise HTTPException(409, f"A role named “{new}” already exists")
                cur.execute("UPDATE shared.roles SET name = %s WHERE id = %s", (new, rid))
                changes.append(f"renamed → {new}")
            if body.note is not None:
                cur.execute("UPDATE shared.roles SET note = %s WHERE id = %s",
                            (body.note, rid))
                changes.append("note updated")
            if body.entra_group is not None:
                cur.execute("UPDATE shared.roles SET entra_group = NULLIF(%s, '') WHERE id = %s",
                            (body.entra_group, rid))
                changes.append(f"entra map → {body.entra_group or '—'}")
            if body.active is not None and body.active != is_active:
                if is_core:
                    raise HTTPException(409, "Core roles stay active — archive is for custom roles")
                cur.execute("UPDATE shared.roles SET active = %s WHERE id = %s",
                            (body.active, rid))
                cur.execute("SELECT count(*) FROM shared.agents WHERE role_id = %s", (rid,))
                (holders,) = cur.fetchone()
                changes.append("restored — back in the pickers" if body.active else
                               "archived — hidden from pickers"
                               + (f"; {holders} holder(s) keep it until reassigned" if holders else ""))
            for pid in body.add:
                cur.execute("""INSERT INTO shared.role_permissions (role_id, permission_id)
                               VALUES (%s, %s) ON CONFLICT DO NOTHING""", (rid, pid))
            for pid in body.remove:
                cur.execute("""DELETE FROM shared.role_permissions
                               WHERE role_id = %s AND permission_id = %s""", (rid, pid))
            if body.add:
                changes.append("granted " + ", ".join(body.add))
            if body.remove:
                changes.append("revoked " + ", ".join(body.remove))
        if changes:
            auth.audit(conn, "desk", "Role updated", f"role:{rid}",
                       f"{name} · " + " · ".join(changes)
                       + " — applies at each agent's next sign-in")
        return {"ok": True}


@router.delete("/roles/{name}")
def delete_role(name: str, request: Request):
    """HARD delete — the one user-approved exception to no-DELETE (0030):
    roles hold no immutable business data; audit.events keeps their story.
    Blocked while ANY agent (active OR deactivated) still holds the role —
    the 0030 guard trigger enforces it even if this pre-check is bypassed."""
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_roles")
        with conn.cursor() as cur:
            cur.execute("SELECT id, is_core FROM shared.roles WHERE name = %s", (name,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "Unknown role")
            rid, is_core = row
            if is_core:
                raise HTTPException(409, "Core roles cannot be deleted")
            cur.execute("SELECT count(*) FROM shared.agents WHERE role_id = %s", (rid,))
            (holders,) = cur.fetchone()
            if holders:
                raise HTTPException(409,
                    f"{holders} agent(s) still hold “{name}” — deactivated agents count; "
                    "reassign them (PATCH /api/directory/agents/{email} with a new role) first")
            try:
                cur.execute("DELETE FROM shared.roles WHERE id = %s", (rid,))
            except pg_errors.RaiseException as e:   # 0030 guard backstop
                raise HTTPException(409, e.diag.message_primary or "Role is guarded")
        auth.audit(conn, "desk", "Role deleted", f"role:{rid}",
                   f"{name} · permanently removed with its permission grants · by {who['label']}")
        return {"ok": True}


# --- activity types: the shared-control-plane part (Directory tab) ---------
# Names and lifecycle live here; billable status and rates stay Ledger-only
# (0017/0018). desk_api's grant is column-scoped to (name, active) — 0019.

class NewAType(BaseModel):
    name: str


@router.post("/types", status_code=201)
def create_atype(body: NewAType, request: Request):
    """New shared activity type — non-billable until Ledger says otherwise,
    exactly like the prototype's saveType."""
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "The type needs a name")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM ledger.activity_types WHERE lower(name) = lower(%s)",
                        (name,))
            if cur.fetchone():
                raise HTTPException(409, f"A type named “{name}” already exists")
            cur.execute("""INSERT INTO ledger.activity_types (name, billable)
                           VALUES (%s, false) RETURNING id""", (name,))
            (tid,) = cur.fetchone()
        auth.audit(conn, "desk", "Activity type added", f"type:{tid}",
                   f"{name} · non-billable until rated in Ledger · by {who['label']}")
        return {"id": str(tid)}


class PatchAType(BaseModel):
    name: str | None = None            # rename
    active: bool | None = None         # archive / restore


@router.patch("/types/{type_id}")
def patch_atype(type_id: str, body: PatchAType, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "manage_settings")
        sets, args, notes = [], [], []
        if body.name is not None and body.name.strip():
            sets.append("name = %s"); args.append(body.name.strip())
            notes.append(f"renamed → {body.name.strip()}")
        if body.active is not None:
            sets.append("active = %s"); args.append(body.active)
            notes.append("restored" if body.active else
                         "archived — hidden from pickers; entries carrying it keep it")
        if not sets:
            return {"ok": True}
        with conn.cursor() as cur:
            try:
                cur.execute(f"UPDATE ledger.activity_types SET {', '.join(sets)} "
                            "WHERE id = %s RETURNING name", (*args, type_id))
            except pg_errors.RaiseException as e:
                raise HTTPException(409, e.diag.message_primary or "Type is guarded")
            except pg_errors.UniqueViolation:
                raise HTTPException(409, "A type with that name already exists")
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such activity type")
        auth.audit(conn, "desk", "Activity type updated", f"type:{type_id}",
                   f"{row[0]} · " + " · ".join(notes))
        return {"ok": True}
