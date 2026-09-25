"""Microsoft 365 contact sync — each linked client's licensed users → contacts.

One multi-tenant app registration in the MSP's own tenant (User.Read.All,
Application), consented once in each client tenant (GDAP lets the MSP do that
itself). Config: app_config 'm365_sync' {enabled, client_id}; the app's client
secret sits sealed in shared.secrets 'm365_sync'. Per client:
shared.m365_tenants (0048) says which tenant and carries the last outcome.

Due = sync_requested ("Sync now", or a freshly linked tenant) or next_due_at
passed. Success → next run in 24 h; failure → retry in 1 h.

Field ownership (user's call, 2026-09-25):
  * name + email — Microsoft 365 is authoritative (overwrites when non-blank)
  * title, department, phone, fax, mobile — FILL ONLY IF EMPTY in Docket; a
    tech's value is never overwritten or blanked. Mobile especially: it is the
    SMS-verification number, so a changed number in the tenant never silently
    redirects verification codes.
  * vip, pref, notes — Docket-only, never touched (no grant either).
Eligible = enabled Member account with at least one licence and an address
on one of the CLIENT'S OWN email domains (shared.client_domains) — a tenant
whose licensed users sit on none of them is refused as a likely mis-link.
Contacts that match a tenant user who is NOT eligible (disabled, unlicensed —
shared/room mailboxes, offboarded staff — or a guest), or whose linked user is
gone from the tenant, are deactivated. Contacts matching nobody in the tenant
(vendors, personal addresses, group aliases) are left alone. Nothing deletes.

Protected sources (0048 contacts.source): 'manual' and 'csv' contacts are
linked and gap-filled like any other, but the sync NEVER changes their active
flag. Only 'mail' (routing-ladder auto-created) and 'm365' contacts are
offboarded, and only a contact the sync itself deactivated (sync_deactivated)
is ever reactivated — a tech's own deactivation is never undone.
"""
import json
import time

import httpx

from . import crypto

GRAPH = "https://graph.microsoft.com/v1.0"
SELECT = ("id,displayName,mail,userPrincipalName,proxyAddresses,jobTitle,department,"
          "businessPhones,mobilePhone,faxNumber,accountEnabled,userType,assignedLicenses")
PER_PASS = 3                       # tenants per scheduler pass — keeps a pass short
TOKENS = {}                        # tenant_id → (token, until)


def _config(cur):
    cur.execute("SELECT value FROM shared.app_config WHERE key = 'm365_sync'")
    row = cur.fetchone()
    cfg = (row[0] if row else None) or {}
    if not (cfg.get("enabled") and cfg.get("client_id")):
        return None
    cur.execute("SELECT ciphertext FROM shared.secrets WHERE name = 'm365_sync'")
    row = cur.fetchone()
    if row is None:
        return None
    return {"client_id": cfg["client_id"], "secret": crypto.open_(row[0]).decode()}


def _token(cfg, tenant):
    hit = TOKENS.get(tenant)
    if hit and time.time() < hit[1] - 120:
        return hit[0]
    resp = httpx.post(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data={"grant_type": "client_credentials", "client_id": cfg["client_id"],
              "client_secret": cfg["secret"],
              "scope": "https://graph.microsoft.com/.default"}, timeout=15)
    if resp.status_code != 200:
        try:
            detail = resp.json().get("error_description", "")
        except ValueError:
            detail = resp.text
        # AADSTS700016 / 65001 = app not consented in that tenant yet
        raise RuntimeError("sign-in to the client tenant failed — "
                           + (detail.split("\r\n")[0][:240] or f"HTTP {resp.status_code}"))
    body = resp.json()
    TOKENS[tenant] = (body["access_token"], time.time() + int(body.get("expires_in", 3599)))
    return body["access_token"]


def _users(token):
    url = f"{GRAPH}/users?$select={SELECT}&$top=999"
    out = []
    while url:
        resp = httpx.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
        if resp.status_code != 200:
            try:
                detail = resp.json().get("error", {}).get("message", "")
            except ValueError:
                detail = resp.text
            raise RuntimeError(f"Graph /users refused ({resp.status_code}) — {detail[:240]}")
        body = resp.json()
        out.extend(body.get("value") or [])
        url = body.get("@odata.nextLink")
    return out


def _s(v):
    return (v or "").replace("\x00", "").strip()


def _address(u):
    mail = _s(u.get("mail")).lower()
    if mail:
        return mail
    upn = _s(u.get("userPrincipalName")).lower()
    # a bare *.onmicrosoft.com login is not a real mailbox address
    return "" if (not upn or upn.endswith(".onmicrosoft.com") or "#ext#" in upn) else upn


def _aliases(u):
    out = {_address(u)}
    for p in u.get("proxyAddresses") or []:
        if p.lower().startswith("smtp:"):
            out.add(p[5:].strip().lower())
    out.discard("")
    return out


def _eligible(u):
    return (u.get("accountEnabled") is True and (u.get("userType") or "Member") == "Member"
            and bool(u.get("assignedLicenses")) and bool(_address(u)))


def _audit(cur, action, entity, detail):
    cur.execute("""INSERT INTO audit.events (app, action, entity, detail)
                   VALUES ('mail', %s, %s, %s)""", (action, entity, detail))


def _on_domains(addr, domains):
    dom = addr.rsplit("@", 1)[-1] if "@" in addr else ""
    return any(dom == d or dom.endswith("." + d) for d in domains)


def sync_client(cur, cfg, client_id, client_name, tenant):
    # wrong-tenant guard (HIPAA review #8): only users on the client's OWN
    # email domains are imported. A client linked to someone else's tenant
    # would otherwise import that company's staff as this client's contacts —
    # and route their mail (and tickets) to the wrong client from then on.
    cur.execute("SELECT lower(domain) FROM shared.client_domains WHERE client_id = %s",
                (client_id,))
    domains = [r[0].strip() for r in cur.fetchall() if r[0] and r[0].strip()]
    if not domains:
        raise RuntimeError("the client has no email domain on file — add it so the "
                           "sync can confirm the tenant belongs to this client")
    token = _token(cfg, tenant)
    users = _users(token)
    licensed = [u for u in users if _eligible(u)]
    eligible = [u for u in licensed if _on_domains(_address(u), domains)]
    if licensed and not eligible:
        raise RuntimeError(f"none of the tenant's {len(licensed)} licensed users are on "
                           f"{', '.join(domains)} — this looks like the wrong tenant; "
                           "nothing was changed")
    by_oid = {u["id"]: u for u in users}
    by_alias = {}
    for u in users:
        for a in _aliases(u):
            by_alias.setdefault(a, u)

    cur.execute("""SELECT id, client_id, name, email, title, department, phone, mobile,
                          fax, active, entra_oid, source, sync_deactivated
                     FROM shared.contacts
                    WHERE client_id = %s OR entra_oid = ANY(%s)""",
                (client_id, [u["id"] for u in eligible]))
    cols = ("id", "client_id", "name", "email", "title", "department", "phone",
            "mobile", "fax", "active", "entra_oid", "source", "sync_deactivated")
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    mine = [r for r in rows if r["client_id"] == client_id]
    c_by_oid = {r["entra_oid"]: r for r in rows if r["entra_oid"]}
    c_by_email = {r["email"].lower(): r for r in mine}
    n = {"users": len(eligible), "added": 0, "updated": 0, "deactivated": 0,
         "conflicts": 0, "unmatched": 0, "protected": 0,
         "offdomain": len(licensed) - len(eligible)}
    touched = set()

    for u in eligible:
        addr = _address(u)
        c = c_by_oid.get(u["id"])
        if c is None:
            c = next((c_by_email[a] for a in _aliases(u) if a in c_by_email
                      and c_by_email[a]["id"] not in touched
                      and c_by_email[a]["entra_oid"] in (None, u["id"])), None)
            if c is None:
                # linked to a user that's gone from the tenant (address reused
                # by a new hire) — relink rather than collide on the address
                c = next((c_by_email[a] for a in _aliases(u) if a in c_by_email
                          and c_by_email[a]["id"] not in touched
                          and c_by_email[a]["entra_oid"] not in by_oid), None)
        if c is not None and c["client_id"] != client_id:
            n["conflicts"] += 1        # linked under another client — never move it
            continue
        want = {"name": _s(u.get("displayName")) or addr,
                "title": _s(u.get("jobTitle")), "department": _s(u.get("department")),
                "phone": _s((u.get("businessPhones") or [""])[0]),
                "mobile": _s(u.get("mobilePhone")), "fax": _s(u.get("faxNumber"))}
        if c is None:
            cur.execute("SELECT client_id FROM shared.contacts WHERE lower(email) = %s", (addr,))
            if cur.fetchone():
                n["conflicts"] += 1    # the address is another client's contact
                continue
            cur.execute("""INSERT INTO shared.contacts
                             (client_id, name, email, title, department, phone, mobile, fax,
                              entra_oid, synced_at, source)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, now(), 'm365')
                           RETURNING id""",
                        (client_id, want["name"], addr, want["title"], want["department"],
                         want["phone"], want["mobile"], want["fax"], u["id"]))
            (cid,) = cur.fetchone()
            touched.add(cid)
            n["added"] += 1
            _audit(cur, "Contact added from Microsoft 365", f"contact:{cid}",
                   f"{want['name']} <{addr}> → {client_name}")
            continue
        touched.add(c["id"])
        sets, changes = {}, []
        if want["name"] and want["name"] != c["name"]:
            sets["name"] = want["name"]
            changes.append(f"name “{c['name']}” → “{want['name']}”")
        if addr != c["email"].lower():
            cur.execute("SELECT 1 FROM shared.contacts WHERE lower(email) = %s AND id <> %s",
                        (addr, c["id"]))
            if cur.fetchone():
                n["conflicts"] += 1
            else:
                sets["email"] = addr
                changes.append(f"email {c['email']} → {addr}")
        for k in ("title", "department", "phone", "mobile", "fax"):
            if want[k] and not _s(c[k]):
                sets[k] = want[k]
                changes.append(f"{k} filled")
        if not c["active"] and c["sync_deactivated"] and c["source"] in ("mail", "m365"):
            sets["active"] = True
            sets["sync_deactivated"] = False
            changes.append("reactivated (licensed + enabled in 365 again)")
        if c["entra_oid"] != u["id"]:
            sets["entra_oid"] = u["id"]
            if not changes:
                changes.append("linked to Microsoft 365")
        sets["synced_at"] = "now()"
        assign = ", ".join(f"{k} = now()" if k == "synced_at" else f"{k} = %s" for k in sets)
        cur.execute(f"UPDATE shared.contacts SET {assign} WHERE id = %s",
                    (*[v for k, v in sets.items() if k != "synced_at"], c["id"]))
        if changes:
            n["updated"] += 1
            _audit(cur, "Contact synced from Microsoft 365", f"contact:{c['id']}",
                   f"{want['name']} · " + " · ".join(changes))

    # offboarding: only contacts we can tie to the tenant. Guard: a tenant
    # that suddenly shows zero licensed users is far likelier a permission
    # or licensing glitch than everyone leaving — skip removals entirely.
    for c in mine:
        if c["id"] in touched or not c["active"]:
            continue
        u = by_oid.get(c["entra_oid"]) if c["entra_oid"] else by_alias.get(c["email"].lower())
        if u is None and not c["entra_oid"]:
            n["unmatched"] += 1        # vendor / personal / group address — leave it
            continue
        if u is not None and _eligible(u):
            continue                   # licensed user we skipped (address conflict)
        if not eligible:
            continue
        if c["source"] not in ("mail", "m365"):
            n["protected"] += 1        # manual / CSV — marked, never auto-removed
            continue
        why = ("no longer in the tenant" if u is None else
               "account disabled" if u.get("accountEnabled") is not True else
               "guest account" if (u.get("userType") or "Member") != "Member" else
               "no licence")
        cur.execute("""UPDATE shared.contacts SET active = false, sync_deactivated = true,
                               synced_at = now() {} WHERE id = %s""".format(
                        ", entra_oid = %s" if u is not None and not c["entra_oid"] else ""),
                    ((u["id"], c["id"]) if u is not None and not c["entra_oid"] else (c["id"],)))
        n["deactivated"] += 1
        _audit(cur, "Contact deactivated by Microsoft 365 sync", f"contact:{c['id']}",
               f"{c['name']} <{c['email']}> · {why}")
    return n


def _summary(n):
    parts = [f"{n['users']} licensed user{'s' if n['users'] != 1 else ''}"]
    for k, label in (("added", "added"), ("updated", "updated"),
                     ("deactivated", "deactivated"), ("conflicts", "skipped (address conflict)"),
                     ("protected", "manual/CSV kept though not licensed in 365"),
                     ("offdomain", "skipped (not on the client's domains)")):
        if n[k]:
            parts.append(f"{n[k]} {label}")
    if not n["users"]:
        parts.append("removals skipped — tenant returned no licensed users")
    return " · ".join(parts)


def sync_pass(conn) -> int:
    """Sync up to PER_PASS due tenants. Each tenant is savepoint-fenced: a
    failure rolls back only that tenant's contact writes, then records why."""
    with conn.cursor() as cur:
        cfg = _config(cur)
        if cfg is None:
            return 0
        cur.execute("""SELECT t.client_id, c.name, t.tenant_id
                         FROM shared.m365_tenants t
                         JOIN shared.clients c ON c.id = t.client_id
                        WHERE t.enabled AND c.archived_at IS NULL AND NOT c.is_sentinel
                          AND (t.sync_requested OR t.next_due_at IS NULL
                               OR t.next_due_at <= now())
                        ORDER BY t.sync_requested DESC, t.next_due_at NULLS FIRST
                        LIMIT %s""", (PER_PASS,))
        due = cur.fetchall()
    done = 0
    for client_id, name, tenant in due:
        with conn.cursor() as cur:
            cur.execute("SAVEPOINT m365")
            try:
                n = sync_client(cur, cfg, client_id, name, tenant)
                cur.execute("RELEASE SAVEPOINT m365")
                cur.execute("""UPDATE shared.m365_tenants
                                  SET sync_requested = false, last_attempt_at = now(),
                                      last_ok_at = now(), next_due_at = now() + interval '24 hours',
                                      last_status = %s, last_counts = %s::jsonb
                                WHERE client_id = %s""",
                            (_summary(n), json.dumps(n), client_id))
                if n["added"] or n["updated"] or n["deactivated"]:
                    _audit(cur, "Microsoft 365 sync", f"client:{client_id}",
                           f"{name} · {_summary(n)}")
                    print(f"m365 sync {name}: {_summary(n)}")
                done += 1
            except Exception as exc:
                cur.execute("ROLLBACK TO SAVEPOINT m365")
                msg = str(exc)[:300]
                cur.execute("""UPDATE shared.m365_tenants
                                  SET sync_requested = false, last_attempt_at = now(),
                                      next_due_at = now() + interval '1 hour',
                                      last_status = %s
                                WHERE client_id = %s""", ("FAILED — " + msg, client_id))
                _audit(cur, "Microsoft 365 sync failed", f"client:{client_id}",
                       f"{name} · {msg}")
                print(f"m365 sync {name} failed: {msg}")
    return done
