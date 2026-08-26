"""Caller verification — one-time codes for sensitive requests (0021).

Two endpoints, mirroring the prototype's modal exactly:

  POST /api/tickets/{id}/verify/start {channel: sms|email}
      → resolves the destination from the CONTACT RECORD (mobile, then
        phone, for SMS; the stored email for email) — the client never
        supplies a destination, so a caller can't social-engineer a code
        to their own number. Sends the code, stores it HASHED with a TTL
        and attempt budget, expires any prior pending code for the
        ticket, and returns {id, masked, ttl_min, attempts} — NEVER the
        code itself.
  POST /api/tickets/{id}/verify/check {verification_id, code}
      → constant-data compare against the hash. Success tags the ticket
        `identity-verified` and posts the ✅ system article; exhausting
        the attempt budget posts the ❌ FAILED article (gated by the
        postToThread setting); both audit. Expiry is checked first and
        reported distinctly so the agent knows to resend, not retry.

Senders: email rides the same Graph mailer as agent replies, from the
configured verification address; SMS goes out via voip.ms (sendSMS REST,
api username + the `voipms` secret) or Twilio (Messages API, account SID +
the `twilio` secret) per the provider chosen in Settings. Channels ship
default-OFF (0021 seed) — enabling one in Settings is the go-live flip,
consistent with mail.outbound_enabled.
"""
import hashlib
import json
import re
import secrets as pysecrets

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import auth, crypto, db, mailer

router = APIRouter(prefix="/api/tickets")

DEFAULTS = {"ttlMin": 5, "attempts": 3, "postToThread": True}


def _vcfg(cur) -> dict:
    cur.execute("SELECT value FROM shared.app_config WHERE key = 'verification'")
    row = cur.fetchone()
    v = row[0] if row else {}
    if isinstance(v, str):
        v = json.loads(v or "{}")
    return {**DEFAULTS, "sms": v.get("sms") or {}, "email": v.get("email") or {},
            **{k: v[k] for k in DEFAULTS if k in v}}


def _secret(cur, name: str) -> str:
    cur.execute("SELECT ciphertext FROM shared.secrets WHERE name = %s", (name,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(409, f"The {name} secret has not been stored — "
                                 "save it in Settings first")
    return crypto.open_(row[0]).decode()


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _mask_phone(s: str) -> str:
    d = _digits(s)
    return f"***{d[-4:]}" if len(d) >= 4 else "***"


def _mask_email(s: str) -> str:
    try:
        local, dom = s.split("@", 1)
        return f"{local[0]}***@{dom[0]}***.{dom.rsplit('.', 1)[-1]}"
    except Exception:
        return "***"


def _send_sms(cur, cfg: dict, dst_raw: str, text: str) -> None:
    dst = _digits(dst_raw)
    if len(dst) == 11 and dst.startswith("1"):
        dst = dst[1:]
    if len(dst) != 10:
        raise HTTPException(422, "Contact's phone number isn't a usable "
                                 "10-digit number — fix it on their record")
    provider = (cfg.get("provider") or "voip.ms").lower()
    did = _digits(cfg.get("did", ""))
    if not did:
        raise HTTPException(409, "No sending DID configured — set it in "
                                 "Settings → Caller verification")
    try:
        if provider == "voip.ms":
            if not cfg.get("apiUser"):
                raise HTTPException(409, "voip.ms API username missing — "
                                         "set it in Settings")
            r = httpx.get("https://voip.ms/api/v1/rest.php", params={
                "api_username": cfg["apiUser"],
                "api_password": _secret(cur, "voipms"),
                "method": "sendSMS", "did": did, "dst": dst,
                "message": text}, timeout=20)
            ok = r.status_code == 200 and r.json().get("status") == "success"
            if not ok:
                detail = r.json().get("status", r.text)[:120] \
                    if r.status_code == 200 else f"HTTP {r.status_code}"
                raise HTTPException(502, f"voip.ms refused the SMS: {detail}")
        else:                                            # Twilio
            sid = cfg.get("twilioSid", "")
            if not sid:
                raise HTTPException(409, "Twilio account SID missing — "
                                         "set it in Settings")
            r = httpx.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                auth=(sid, _secret(cur, "twilio")),
                data={"From": f"+1{did}", "To": f"+1{dst}", "Body": text},
                timeout=20)
            if r.status_code not in (200, 201):
                detail = r.json().get("message", r.text)[:120]
                raise HTTPException(502, f"Twilio refused the SMS: {detail}")
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"SMS provider unreachable: {str(exc)[:120]}")


class Start(BaseModel):
    channel: str            # sms | email


class Check(BaseModel):
    verification_id: str
    code: str


@router.post("/{ticket_id}/verify/start")
def start(ticket_id: int, body: Start, request: Request):
    if body.channel not in ("sms", "email"):
        raise HTTPException(422, "channel must be sms or email")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "verify_identity")
        with conn.cursor() as cur:
            v = _vcfg(cur)
            ch = v[body.channel]
            if not ch.get("enabled"):
                raise HTTPException(409, f"The {body.channel.upper()} channel is "
                                         "disabled — enable it in Settings → "
                                         "Caller verification")
            cur.execute("""SELECT t.contact_id, c.phone, c.mobile, c.email, c.name
                             FROM desk.tickets t
                        LEFT JOIN shared.contacts c ON c.id = t.contact_id
                            WHERE t.id = %s""", (ticket_id,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such ticket")
            contact_id, phone, mobile, email, _name = row
            if contact_id is None:
                raise HTTPException(409, "Ticket has no contact on file")

            # destination comes from the stored record ONLY
            if body.channel == "sms":
                dst = mobile or phone
                if not dst:
                    raise HTTPException(409, "No phone number on the contact's "
                                             "record — add one first")
                masked = _mask_phone(dst)
            else:
                dst = email
                if not dst:
                    raise HTTPException(409, "No email on the contact's record")
                masked = _mask_email(dst)

            code = str(pysecrets.randbelow(900000) + 100000)
            ttl, tries = int(v["ttlMin"]), int(v["attempts"])

            if body.channel == "sms":
                _send_sms(cur, ch, dst,
                          f"Hemingway Tech Solutions verification code: {code}. "
                          f"Expires in {ttl} minutes. Only share it with the "
                          f"technician on your call.")
            else:
                sender = ch.get("from", "")
                if not sender:
                    raise HTTPException(409, "No verification from-address "
                                             "configured — set it in Settings")
                mailer.send_reply(
                    cur, mailbox_address=sender,
                    display_name="Hemingway Tech Solutions",
                    to=dst, cc=[], subject="Your verification code",
                    body=f"Your Hemingway Tech Solutions verification code is "
                         f"{code}\n\nIt expires in {ttl} minutes. Only share it "
                         f"with the technician on your call.",
                    in_reply_to=None, references=[])

            # a fresh code supersedes any pending one on the ticket
            cur.execute("""UPDATE desk.verifications SET status = 'expired',
                                  resolved_at = now()
                            WHERE ticket_id = %s AND status = 'pending'""",
                        (ticket_id,))
            cur.execute("""INSERT INTO desk.verifications
                             (ticket_id, contact_id, channel, masked, code_hash,
                              expires_at, attempts_left, created_by)
                           VALUES (%s, %s, %s, %s, %s,
                                   now() + make_interval(mins => %s), %s, %s)
                        RETURNING id""",
                        (ticket_id, contact_id, body.channel, masked,
                         hashlib.sha256(code.encode()).hexdigest(), ttl, tries,
                         who.get("agent_id")))
            vid = cur.fetchone()[0]
        auth.audit(conn, "desk", "Verification code sent",
                   f"ticket:{ticket_id}",
                   f"#{ticket_id} · {body.channel.upper()} to {masked} "
                   f"by {who.get('name') or who.get('label')}")
    return {"id": str(vid), "masked": masked, "ttl_min": ttl, "attempts": tries}


@router.post("/{ticket_id}/verify/check")
def check(ticket_id: int, body: Check, request: Request):
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "verify_identity")
        with conn.cursor() as cur:
            v = _vcfg(cur)
            cur.execute("""SELECT id, channel, masked, code_hash, expires_at < now(),
                                  attempts_left, status
                             FROM desk.verifications
                            WHERE id = %s AND ticket_id = %s""",
                        (body.verification_id, ticket_id))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "No such verification")
            vid, channel, masked, code_hash, expired, attempts_left, status = row
            chan = "SMS" if channel == "sms" else "email"
            if status != "pending":
                raise HTTPException(409, f"This code is already {status} — "
                                         "send a new one")
            if expired:
                cur.execute("""UPDATE desk.verifications SET status = 'expired',
                                      resolved_at = now() WHERE id = %s""", (vid,))
                return {"result": "expired"}

            entered = re.sub(r"\D", "", body.code or "")
            import hmac as _hmac
            if _hmac.compare_digest(hashlib.sha256(entered.encode()).hexdigest(),
                                    code_hash):
                cur.execute("""UPDATE desk.verifications SET status = 'verified',
                                      resolved_at = now() WHERE id = %s""", (vid,))
                # tag + the same system article the prototype posts
                cur.execute("""INSERT INTO desk.ticket_tags (ticket_id, tag)
                               VALUES (%s, 'identity-verified')
                               ON CONFLICT DO NOTHING""", (ticket_id,))
                cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s",
                            (ticket_id,))
                cur.execute("""INSERT INTO desk.articles
                                 (ticket_id, kind, author, author_id, body)
                               VALUES (%s, 'sys', %s, %s, %s)""",
                            (ticket_id, who.get("name") or who.get("label") or "API",
                             who.get("agent_id"),
                             f"\u2705 Identity verified via {chan} to {masked} "
                             f"\u00b7 handled by {who.get('name') or who.get('label')}"))
                auth.audit(conn, "desk", "Identity verified",
                           f"ticket:{ticket_id}",
                           f"#{ticket_id} \u00b7 {chan} to {masked}")
                return {"result": "verified"}

            attempts_left -= 1
            if attempts_left <= 0:
                cur.execute("""UPDATE desk.verifications SET status = 'failed',
                                      attempts_left = 0, resolved_at = now()
                                WHERE id = %s""", (vid,))
                if v["postToThread"]:
                    cur.execute("""INSERT INTO desk.articles
                                     (ticket_id, kind, author, author_id, body)
                                   VALUES (%s, 'sys', %s, %s, %s)""",
                                (ticket_id, who.get("name") or who.get("label") or "API",
                                 who.get("agent_id"),
                                 f"\u274c Identity verification FAILED \u2014 "
                                 f"{int(v['attempts'])} incorrect attempts via "
                                 f"{chan} to {masked} \u00b7 handled by "
                                 f"{who.get('name') or who.get('label')}. Treat the caller as "
                                 f"unverified."))
                cur.execute("UPDATE desk.tickets SET updated_at = now() WHERE id = %s",
                            (ticket_id,))
                auth.audit(conn, "desk", "Verification failed",
                           f"ticket:{ticket_id}",
                           f"#{ticket_id} \u00b7 attempt budget exhausted via {chan}")
                return {"result": "failed"}
            cur.execute("""UPDATE desk.verifications SET attempts_left = %s
                            WHERE id = %s""", (attempts_left, vid))
        return {"result": "wrong", "attempts_left": attempts_left}
