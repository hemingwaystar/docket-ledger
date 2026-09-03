"""Outbound mail for TRIGGER emails — the worker-side twin of desk-api's
mailer. Same MIME construction (stdlib EmailMessage, base64 to /sendMail)
so threading headers behave identically; same gate (mail.outbound_enabled).
Differences from the API version: raises MailError instead of HTTPException,
and callers treat "outbound disabled" as record-only, exactly like agent
replies staged before launch.

Loop guard note: the engine NEVER runs an email action for events whose
meta says the source mail was auto-generated (Auto-Submitted / bulk) — see
automations.fire_triggers — so trigger auto-replies can't answer a
mailer-daemon and ping-pong.
"""
import base64
import json
import time
from email.message import EmailMessage
from email.utils import make_msgid

import httpx

from . import crypto


class MailError(Exception):
    pass


_TOKEN = {"token": None, "until": 0.0}


def outbound_enabled(cur) -> bool:
    cur.execute("SELECT value FROM shared.app_config WHERE key = 'mail'")
    row = cur.fetchone()
    cfg = row[0] if row else {}
    if isinstance(cfg, str):
        cfg = json.loads(cfg)
    return bool((cfg or {}).get("outbound_enabled"))


def _token(cur) -> str:
    if _TOKEN["token"] and time.time() < _TOKEN["until"] - 120:
        return _TOKEN["token"]
    cur.execute("SELECT value FROM shared.app_config WHERE key = 'graph'")
    row = cur.fetchone()
    cfg = row[0] if row else {}
    if isinstance(cfg, str):
        cfg = json.loads(cfg)
    if not cfg.get("connected"):
        raise MailError("Graph is not connected")
    cur.execute("SELECT ciphertext FROM shared.secrets WHERE name = 'graph'")
    row = cur.fetchone()
    if row is None:
        raise MailError("No Graph secret stored")
    secret = crypto.open_(row[0]).decode()
    resp = httpx.post(
        f"https://login.microsoftonline.com/{cfg['tenant']}/oauth2/v2.0/token",
        data={"grant_type": "client_credentials", "client_id": cfg["client_id"],
              "client_secret": secret,
              "scope": "https://graph.microsoft.com/.default"}, timeout=15)
    if resp.status_code != 200:
        raise MailError("Entra token failed: "
                        + resp.json().get("error_description", resp.text)[:200])
    body = resp.json()
    _TOKEN["token"] = body["access_token"]
    _TOKEN["until"] = time.time() + int(body.get("expires_in", 3599))
    return _TOKEN["token"]


def send_reply(cur, *, mailbox_address: str, display_name: str,
               to: str, subject: str, body: str,
               in_reply_to: str | None, references: list[str]) -> str:
    """Sends and returns our outbound Message-ID; raises MailError on any
    failure — callers treat a raise as 'not sent'."""
    msg = EmailMessage()
    sender = f"{display_name} <{mailbox_address}>" if display_name else mailbox_address
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = subject
    message_id = make_msgid(domain=mailbox_address.split("@")[-1])
    msg["Message-ID"] = message_id
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = " ".join(references[-10:])
    msg.set_content(body)

    token = _token(cur)
    mime = base64.b64encode(msg.as_bytes()).decode()
    if len(mime) > 4 * 1024 * 1024:
        # Graph's sendMail cap is 4 MB of the BASE64 payload, not the raw MIME —
        # measure the encoded size, exactly like desk-api's mailer (audit: the
        # raw-bytes check let a message up to ~5.3 MB encoded slip past here and
        # then 413 opaquely at Graph).
        raise MailError("Message exceeds Graph's 4 MB (base64) MIME limit")
    resp = httpx.post(
        f"https://graph.microsoft.com/v1.0/users/{mailbox_address}/sendMail",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
        content=mime, timeout=30)
    if resp.status_code != 202:
        raise MailError(f"Graph refused the send ({resp.status_code}): "
                        + resp.text[:300])
    return message_id
