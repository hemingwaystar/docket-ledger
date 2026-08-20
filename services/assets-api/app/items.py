"""Asset (CI) writes — create and version-locked patch. Archive rides the
patch ({archived: true/false}); retirement is the 'retired' STATUS (still
listed), archiving hides the row. No DELETE anywhere (house doctrine)."""
from fastapi import APIRouter, HTTPException, Request
from psycopg import errors as pg_errors
from pydantic import BaseModel
from . import auth, db, helpers

router = APIRouter()


class NewAsset(BaseModel):
    ci_tag: str
    name: str
    atype: str
    client_id: str
    assigned_to: str = ""
    status: str = "inuse"
    serial: str = ""
    vendor: str = ""
    purchased_on: str | None = None
    warranty_until: str | None = None
    cost_cents: int | None = None
    note: str = ""


@router.post("/api/assets", status_code=201)
def create_asset(body: NewAsset, request: Request):
    ci_tag, name = body.ci_tag.strip(), body.name.strip()
    if not ci_tag or not name:
        raise HTTPException(422, "CI tag and name are both required")
    if body.atype not in helpers.ATYPES:
        raise HTTPException(422, f"atype must be one of {', '.join(helpers.ATYPES)}")
    if body.status not in helpers.STATUSES:
        raise HTTPException(422, f"status must be one of {', '.join(helpers.STATUSES)}")
    purchased = helpers.sane_date(body.purchased_on, "purchased_on")
    warranty = helpers.sane_date(body.warranty_until, "warranty_until")
    helpers.cents_ok(body.cost_cents)
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "a_manage_assets")
        with conn.cursor() as cur:
            helpers.client_or_422(cur, body.client_id)
            try:
                cur.execute("""INSERT INTO assets.assets
                                 (ci_tag, name, atype, client_id, assigned_to, status,
                                  serial, vendor, purchased_on, warranty_until, cost_cents, note)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                               RETURNING id, version, updated_at""",
                            (ci_tag, name, body.atype, body.client_id, body.assigned_to.strip(),
                             body.status, body.serial.strip(), body.vendor.strip(),
                             purchased, warranty, body.cost_cents, body.note.strip()))
            except pg_errors.UniqueViolation:
                raise HTTPException(409, f"CI tag “{ci_tag}” is already in use")
            aid, version, updated_at = cur.fetchone()
            helpers.event(cur, "asset", aid, who,
                          f"Asset added — {ci_tag} {name} ({body.atype})")
        auth.audit(conn, "assets", "Asset added", f"asset:{aid}",
                   f"{ci_tag} {name} · {body.atype} ({who['label']})")
        return {"id": str(aid), "version": version, "updatedAt": helpers.ms(updated_at)}


class PatchAsset(BaseModel):
    version: int                      # optimistic-lock token from the last read
    ci_tag: str | None = None
    name: str | None = None
    atype: str | None = None
    client_id: str | None = None
    assigned_to: str | None = None
    status: str | None = None
    serial: str | None = None
    vendor: str | None = None
    purchased_on: str | None = None   # "" clears
    warranty_until: str | None = None # "" clears
    cost_cents: int | None = None
    clear_cost: bool = False          # cost_cents=None means "untouched", so clearing is explicit
    note: str | None = None
    archived: bool | None = None


@router.patch("/api/assets/{asset_id}")
def patch_asset(asset_id: str, body: PatchAsset, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "a_manage_assets")
        sets, args, notes = [], [], []
        with conn.cursor() as cur:
            if body.ci_tag is not None:
                tag = body.ci_tag.strip()
                if not tag:
                    raise HTTPException(422, "The CI tag can't be blank")
                sets.append("ci_tag = %s"); args.append(tag); notes.append(f"tag → {tag}")
            if body.name is not None:
                nm = body.name.strip()
                if not nm:
                    raise HTTPException(422, "The name can't be blank")
                sets.append("name = %s"); args.append(nm); notes.append(f"name → {nm}")
            if body.atype is not None:
                if body.atype not in helpers.ATYPES:
                    raise HTTPException(422, f"atype must be one of {', '.join(helpers.ATYPES)}")
                sets.append("atype = %s"); args.append(body.atype); notes.append(f"type → {body.atype}")
            if body.client_id is not None:
                helpers.client_or_422(cur, body.client_id)
                sets.append("client_id = %s"); args.append(body.client_id); notes.append("client moved")
            if body.assigned_to is not None:
                sets.append("assigned_to = %s"); args.append(body.assigned_to.strip())
                notes.append(f"assigned → {body.assigned_to.strip() or '—'}")
            if body.status is not None:
                if body.status not in helpers.STATUSES:
                    raise HTTPException(422, f"status must be one of {', '.join(helpers.STATUSES)}")
                sets.append("status = %s"); args.append(body.status); notes.append(f"status → {body.status}")
            if body.serial is not None:
                sets.append("serial = %s"); args.append(body.serial.strip()); notes.append("serial edited")
            if body.vendor is not None:
                sets.append("vendor = %s"); args.append(body.vendor.strip()); notes.append("vendor edited")
            if body.purchased_on is not None:
                d = helpers.sane_date(body.purchased_on, "purchased_on")
                sets.append("purchased_on = %s"); args.append(d)
                notes.append(f"purchased → {d or '—'}")
            if body.warranty_until is not None:
                d = helpers.sane_date(body.warranty_until, "warranty_until")
                sets.append("warranty_until = %s"); args.append(d)
                notes.append(f"warranty → {d or '—'}")
            if body.cost_cents is not None or body.clear_cost:
                c = None if body.clear_cost else helpers.cents_ok(body.cost_cents)
                sets.append("cost_cents = %s"); args.append(c)
                notes.append("cost cleared" if c is None else f"cost → {c}c")
            if body.note is not None:
                sets.append("note = %s"); args.append(body.note.strip()); notes.append("note edited")
            if body.archived is not None:
                sets.append("archived_at = " + ("now()" if body.archived else "NULL"))
                notes.append("archived" if body.archived else "restored")
            if not sets:
                return {"ok": True, "changed": []}
            try:
                cur.execute(f"""UPDATE assets.assets SET {', '.join(sets)}
                                 WHERE id::text = %s AND version = %s
                               RETURNING ci_tag, version, updated_at""",
                            (*args, asset_id, body.version))
            except pg_errors.UniqueViolation:
                raise HTTPException(409, "That CI tag is already in use")
            row = cur.fetchone()
            if row is None:
                raise HTTPException(409, "Version conflict or missing asset — re-read and retry")
            tag, version, updated_at = row
            helpers.event(cur, "asset", asset_id, who, "Asset updated — " + " · ".join(notes))
        auth.audit(conn, "assets", "Asset updated", f"asset:{asset_id}",
                   f"{tag} · " + " · ".join(notes) + f" ({who['label']})")
        return {"ok": True, "changed": notes, "version": version,
                "updatedAt": helpers.ms(updated_at)}
