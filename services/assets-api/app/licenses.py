"""Software & licence pool writes. Terms are TYPED (term_months 1–120 +
recurring flag, user decision 2026-08-20); cost_cents is PER SEAT per term
(the $4.80-seat M365 case, 27e) — the pool pays cost_cents × seats_total,
billed up front. Build 29 must post the POOL (unit × seats_total); Build 30
advances recurring terms. seats_used may exceed seats_total: over-allocation
is a true-up flag, not an input error."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from . import auth, db, helpers

router = APIRouter()


class NewLicense(BaseModel):
    product: str
    vendor: str = ""
    client_id: str | None = None      # None/"" = MSP-wide pool
    seats_total: int = 1
    seats_used: int = 0
    term_months: int = 12
    recurring: bool = False
    term_started_on: str | None = None   # default: today
    cost_cents: int = 0
    note: str = ""


SEAT_CAP = 1_000_000   # ceiling keeps absurd input a 422, not an int4 500


def _seats(total, used):
    if not isinstance(total, int) or not (1 <= total <= SEAT_CAP):
        raise HTTPException(422, f"seats_total must be 1 to {SEAT_CAP}")
    if not isinstance(used, int) or not (0 <= used <= SEAT_CAP):
        raise HTTPException(422, f"seats_used must be 0 to {SEAT_CAP}")


@router.post("/api/licenses", status_code=201)
def create_license(body: NewLicense, request: Request):
    product = body.product.strip()
    if not product:
        raise HTTPException(422, "The licence needs a product name")
    _seats(body.seats_total, body.seats_used)
    helpers.term_ok(body.term_months)
    helpers.cents_ok(body.cost_cents)
    started = helpers.sane_date(body.term_started_on, "term_started_on")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "a_manage_licenses")
        with conn.cursor() as cur:
            cid = helpers.client_or_422(cur, body.client_id, allow_none=True)
            cur.execute("""INSERT INTO assets.licenses
                             (product, vendor, client_id, seats_total, seats_used,
                              term_months, recurring, term_started_on, cost_cents, note)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,COALESCE(%s, current_date),%s,%s)
                           RETURNING id, version, updated_at""",
                        (product, body.vendor.strip(), cid, body.seats_total, body.seats_used,
                         body.term_months, body.recurring, started, body.cost_cents,
                         body.note.strip()))
            lid, version, updated_at = cur.fetchone()
            helpers.event(cur, "license", lid, who,
                          f"Licence added — {product} · {body.seats_used}/{body.seats_total} seats · "
                          f"{helpers.term_label(body.term_months, body.recurring)}")
        auth.audit(conn, "assets", "Licence added", f"license:{lid}",
                   f"{product} · {helpers.term_label(body.term_months, body.recurring)} ({who['label']})")
        return {"id": str(lid), "version": version, "updatedAt": helpers.ms(updated_at)}


class PatchLicense(BaseModel):
    version: int
    product: str | None = None
    vendor: str | None = None
    client_id: str | None = None      # "" = make MSP-wide
    seats_total: int | None = None
    seats_used: int | None = None
    term_months: int | None = None
    recurring: bool | None = None
    term_started_on: str | None = None
    cost_cents: int | None = None
    note: str | None = None
    archived: bool | None = None


@router.patch("/api/licenses/{license_id}")
def patch_license(license_id: str, body: PatchLicense, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "a_manage_licenses")
        sets, args, notes = [], [], []
        with conn.cursor() as cur:
            if body.product is not None:
                p = body.product.strip()
                if not p:
                    raise HTTPException(422, "The product name can't be blank")
                sets.append("product = %s"); args.append(p); notes.append(f"product → {p}")
            if body.vendor is not None:
                sets.append("vendor = %s"); args.append(body.vendor.strip()); notes.append("vendor edited")
            if body.client_id is not None:
                cid = helpers.client_or_422(cur, body.client_id, allow_none=True)
                sets.append("client_id = %s"); args.append(cid)
                notes.append("scope → MSP-wide" if cid is None else "client moved")
            if body.seats_total is not None:
                if not (1 <= body.seats_total <= SEAT_CAP):
                    raise HTTPException(422, f"seats_total must be 1 to {SEAT_CAP}")
                sets.append("seats_total = %s"); args.append(body.seats_total)
                notes.append(f"seats → {body.seats_total}")
            if body.seats_used is not None:
                if not (0 <= body.seats_used <= SEAT_CAP):
                    raise HTTPException(422, f"seats_used must be 0 to {SEAT_CAP}")
                sets.append("seats_used = %s"); args.append(body.seats_used)
                notes.append(f"in use → {body.seats_used}")
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
                notes.append(f"cost → {body.cost_cents}c/seat/term")
            if body.note is not None:
                sets.append("note = %s"); args.append(body.note.strip()); notes.append("note edited")
            if body.archived is not None:
                sets.append("archived_at = " + ("now()" if body.archived else "NULL"))
                notes.append("archived" if body.archived else "restored")
            if not sets:
                return {"ok": True, "changed": []}
            cur.execute(f"""UPDATE assets.licenses SET {', '.join(sets)}
                             WHERE id::text = %s AND version = %s
                           RETURNING product, version, updated_at""",
                        (*args, license_id, body.version))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(409, "Version conflict or missing licence — re-read and retry")
            product, version, updated_at = row
            helpers.event(cur, "license", license_id, who,
                          "Licence updated — " + " · ".join(notes))
        auth.audit(conn, "assets", "Licence updated", f"license:{license_id}",
                   f"{product} · " + " · ".join(notes) + f" ({who['label']})")
        return {"ok": True, "changed": notes, "version": version,
                "updatedAt": helpers.ms(updated_at)}
