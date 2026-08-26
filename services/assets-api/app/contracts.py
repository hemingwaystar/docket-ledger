"""Vendor contract / warranty writes + the covered-asset membership.
Same typed-term model as licences (term_months + recurring, cost per term,
up front). PUT /{id}/assets is a FULL-REPLACE membership write cloning
Docket's set_assignees (0032): no version predicate (it can't 409), unknown
or archived asset ids are skipped, and the contract row is touched so its
version comes back to the client (the F1 lesson — never strand a bumped
version server-side)."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from . import auth, db, helpers

router = APIRouter()


class NewContract(BaseModel):
    vendor: str                        # agreement name: 'Dell ProSupport Plus'
    kind: str = "support"
    client_id: str
    scope_note: str = ""
    term_months: int = 12
    recurring: bool = False
    term_started_on: str | None = None
    cost_cents: int = 0


@router.post("/api/contracts", status_code=201)
def create_contract(body: NewContract, request: Request):
    vendor = body.vendor.strip()
    if not vendor:
        raise HTTPException(422, "The agreement needs a name")
    if body.kind not in helpers.CONTRACT_KINDS:
        raise HTTPException(422, f"kind must be one of {', '.join(helpers.CONTRACT_KINDS)}")
    helpers.term_ok(body.term_months)
    helpers.cents_ok(body.cost_cents)
    started = helpers.sane_date(body.term_started_on, "term_started_on")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "a_manage_contracts")
        with conn.cursor() as cur:
            helpers.client_or_422(cur, body.client_id)
            cur.execute("""INSERT INTO assets.contracts
                             (vendor, kind, client_id, scope_note, term_months,
                              recurring, term_started_on, cost_cents)
                           VALUES (%s,%s,%s,%s,%s,%s,COALESCE(%s, current_date),%s)
                           RETURNING id, version, updated_at""",
                        (vendor, body.kind, body.client_id, body.scope_note.strip(),
                         body.term_months, body.recurring, started, body.cost_cents))
            ctid, version, updated_at = cur.fetchone()
            helpers.event(cur, "contract", ctid, who,
                          f"Contract added — {vendor} ({body.kind}) · "
                          f"{helpers.term_label(body.term_months, body.recurring)}")
        auth.audit(conn, "assets", "Contract added", f"contract:{ctid}",
                   f"{vendor} · {body.kind} · {helpers.term_label(body.term_months, body.recurring)} "
                   f"({who['label']})")
        return {"id": str(ctid), "version": version, "updatedAt": helpers.ms(updated_at)}


class PatchContract(BaseModel):
    version: int
    vendor: str | None = None
    kind: str | None = None
    client_id: str | None = None
    scope_note: str | None = None
    term_months: int | None = None
    recurring: bool | None = None
    term_started_on: str | None = None
    cost_cents: int | None = None
    archived: bool | None = None


@router.patch("/api/contracts/{contract_id}")
def patch_contract(contract_id: str, body: PatchContract, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "a_manage_contracts")
        sets, args, notes = [], [], []
        with conn.cursor() as cur:
            # archived records are read-only except the restore itself
            # (audit: every field stayed fully mutable server-side)
            cur.execute("SELECT archived_at FROM assets.contracts WHERE id::text = %s", (contract_id,))
            _arow = cur.fetchone()
            if _arow is None:
                raise HTTPException(404, "No such contract")
            if _arow[0] is not None and body.archived is not False:
                raise HTTPException(409, "This contract is archived — restore it first")
            if body.vendor is not None:
                v = body.vendor.strip()
                if not v:
                    raise HTTPException(422, "The agreement name can't be blank")
                sets.append("vendor = %s"); args.append(v); notes.append(f"name → {v}")
            if body.kind is not None:
                if body.kind not in helpers.CONTRACT_KINDS:
                    raise HTTPException(422, f"kind must be one of {', '.join(helpers.CONTRACT_KINDS)}")
                sets.append("kind = %s"); args.append(body.kind); notes.append(f"kind → {body.kind}")
            if body.client_id is not None:
                helpers.client_or_422(cur, body.client_id)
                sets.append("client_id = %s"); args.append(body.client_id); notes.append("client moved")
            if body.scope_note is not None:
                sets.append("scope_note = %s"); args.append(body.scope_note.strip())
                notes.append("coverage note edited")
            if body.term_months is not None:
                helpers.term_ok(body.term_months)
                sets.append("term_months = %s"); args.append(body.term_months)
                notes.append(f"term → {helpers.term_label(body.term_months, False)}")
            if body.recurring is not None:
                sets.append("recurring = %s"); args.append(body.recurring)
                notes.append("recurring on" if body.recurring else "recurring off")
            if body.term_started_on is not None:
                d = helpers.sane_date(body.term_started_on, "term_started_on")
                if d is None:
                    raise HTTPException(422, "term_started_on can't be cleared")
                sets.append("term_started_on = %s"); args.append(d)
                notes.append(f"term start → {d}")
            if body.cost_cents is not None:
                helpers.cents_ok(body.cost_cents)
                sets.append("cost_cents = %s"); args.append(body.cost_cents)
                notes.append(f"cost → {body.cost_cents}c/term")
            if body.archived is not None:
                sets.append("archived_at = " + ("now()" if body.archived else "NULL"))
                notes.append("archived" if body.archived else "restored")
            if not sets:
                return {"ok": True, "changed": []}
            cur.execute(f"""UPDATE assets.contracts SET {', '.join(sets)}
                             WHERE id::text = %s AND version = %s
                           RETURNING vendor, version, updated_at""",
                        (*args, contract_id, body.version))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(409, "Version conflict or missing contract — re-read and retry")
            vendor, version, updated_at = row
            helpers.event(cur, "contract", contract_id, who,
                          "Contract updated — " + " · ".join(notes))
        auth.audit(conn, "assets", "Contract updated", f"contract:{contract_id}",
                   f"{vendor} · " + " · ".join(notes) + f" ({who['label']})")
        return {"ok": True, "changed": notes, "version": version,
                "updatedAt": helpers.ms(updated_at)}


class CoveredAssets(BaseModel):
    asset_ids: list[str] = []


@router.put("/api/contracts/{contract_id}/assets")
def set_covered_assets(contract_id: str, body: CoveredAssets, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "a_manage_contracts")
        with conn.cursor() as cur:
            cur.execute("SELECT vendor, client_id FROM assets.contracts WHERE id::text = %s",
                        (contract_id,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such contract")
            vendor, ct_client = row
            # validate against live assets OF THE CONTRACT'S CLIENT; unknown/
            # archived/other-client ids are skipped, exactly how set_assignees
            # skips inactive agents — coverage never silently spans clients
            keep = []
            if body.asset_ids:
                cur.execute("""SELECT id, ci_tag FROM assets.assets
                                WHERE id::text = ANY(%s) AND archived_at IS NULL
                                  AND client_id = %s""",
                            (body.asset_ids, ct_client))
                keep = cur.fetchall()
            cur.execute("DELETE FROM assets.contract_assets WHERE contract_id::text = %s",
                        (contract_id,))
            for aid, _tag in keep:
                cur.execute("""INSERT INTO assets.contract_assets (contract_id, asset_id, added_by)
                               VALUES (%s, %s, %s)""", (contract_id, aid, who["label"]))
            tags = ", ".join(t for _a, t in keep) or "—"
            helpers.event(cur, "contract", contract_id, who, f"Coverage set — {tags}")
            # touch so the bumped version comes back with the response (F1)
            cur.execute("""UPDATE assets.contracts SET updated_at = now()
                            WHERE id::text = %s RETURNING version, updated_at""", (contract_id,))
            version, updated_at = cur.fetchone()
        auth.audit(conn, "assets", "Contract coverage set", f"contract:{contract_id}",
                   f"{vendor} · covers {len(keep)} asset{'s' if len(keep) != 1 else ''} ({who['label']})")
        return {"ok": True, "assetIds": [str(a) for a, _t in keep],
                "version": version, "updatedAt": helpers.ms(updated_at)}
