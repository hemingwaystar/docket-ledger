"""Assets admin writes — one config key ('assets': the coverage-lapse scan
settings Build 30's worker pass consumes). Same INSERT..ON CONFLICT shape as
ledger's put_config (0016 grants precedent)."""
import json
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from . import auth, db

router = APIRouter()


class ConfigValue(BaseModel):
    value: dict


@router.put("/api/config/assets")
def put_config(body: ConfigValue, request: Request):
    v = body.value
    lead = v.get("lapse_lead_days")
    # bool subclasses int in Python — JSON true would otherwise pass as 1
    if not isinstance(lead, int) or isinstance(lead, bool) or not (1 <= lead <= 365):
        raise HTTPException(422, "lapse_lead_days must be a whole number from 1 to 365")
    if not isinstance(v.get("lapse_group"), str) or not v["lapse_group"].strip():
        raise HTTPException(422, "lapse_group must name a Docket group (the alerts board)")
    kinds = v.get("lapse_kinds")
    if (not isinstance(kinds, dict)
            or set(kinds) != {"warranty", "license", "contract"}
            or not all(isinstance(x, bool) for x in kinds.values())):
        raise HTTPException(422, "lapse_kinds must set warranty/license/contract to true or false")
    clean = {"lapse_lead_days": lead, "lapse_group": v["lapse_group"].strip(),
             "lapse_kinds": kinds}
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "a_manage_settings")
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO shared.app_config (key, value)
                           VALUES ('assets', %s)
                           ON CONFLICT (key) DO UPDATE
                             SET value = EXCLUDED.value, updated_at = now(),
                                 updated_by = shared.current_actor(),
                                 version = shared.app_config.version + 1""",
                        (json.dumps(clean),))
        auth.audit(conn, "assets", "Settings changed", "config:assets",
                   f"lapse scan: {lead}d lead → group “{clean['lapse_group']}” · "
                   + ", ".join(k for k, on in kinds.items() if on) + f" ({who['label']})")
        return {"ok": True}
