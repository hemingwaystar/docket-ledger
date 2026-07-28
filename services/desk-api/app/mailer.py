"""Outbound mail via Graph — replies sent AS the group's mailbox (GROUP_SENDAS).

MIME is built with the stdlib and posted base64 to /sendMail, because Graph's
JSON message format only allows custom x- headers — and proper threading needs
real In-Reply-To/References so the customer's mail client keeps one
conversation. Our own Message-ID is generated and stored on the article, so
the customer's eventual reply threads straight back via ingestion.

Loop guard by construction: only agent-initiated replies call this. Nothing
automated sends mail, and ingestion never triggers sends.
"""
import base64
import json
import time
from email.message import EmailMessage
from email.utils import make_msgid

import httpx
from fastapi import HTTPException

from . import crypto

_TOKEN = {"token": None, "until": 0.0}


def outbound_enabled(cur) -> bool:
    cur.execute("SELECT value FROM shared.app_config WHERE key = 'mail'")
    row = cur.fetchone()
    cfg = row[0] if row else {}
    if isinstance(cfg, str):
        cfg = json.loads(cfg)
    return bool(cfg.get("outbound_enabled"))


def _token(cur) -> str:
    if _TOKEN["token"] and time.time() < _TOKEN["until"] - 120:
        return _TOKEN["token"]
    cur.execute("SELECT value FROM shared.app_config WHERE key = 'graph'")
    row = cur.fetchone()
    cfg = row[0] if row else {}
    if isinstance(cfg, str):
        cfg = json.loads(cfg)
    if not cfg.get("connected"):
        raise HTTPException(409, "Graph is not connected — run settings/graph/test first")
    cur.execute("SELECT ciphertext FROM shared.secrets WHERE name = 'graph'")
    row = cur.fetchone()
    if row is None:
        raise HTTPException(409, "No Graph secret stored")
    secret = crypto.open_(row[0]).decode()
    resp = httpx.post(
        f"https://login.microsoftonline.com/{cfg['tenant']}/oauth2/v2.0/token",
        data={"grant_type": "client_credentials", "client_id": cfg["client_id"],
              "client_secret": secret,
              "scope": "https://graph.microsoft.com/.default"}, timeout=15)
    if resp.status_code != 200:
        raise HTTPException(502, "Entra token failed: "
                            + resp.json().get("error_description", resp.text)[:200])
    body = resp.json()
    _TOKEN["token"] = body["access_token"]
    _TOKEN["until"] = time.time() + int(body.get("expires_in", 3599))
    return _TOKEN["token"]


def send_reply(cur, *, mailbox_address: str, display_name: str,
               to: str, cc: list[str], subject: str, body: str,
               in_reply_to: str | None, references: list[str]) -> str:
    """Sends and returns our outbound Message-ID. Raises HTTPException on
    any failure — callers treat a raise as 'not sent'."""
    msg = EmailMessage()
    sender = f"{display_name} <{mailbox_address}>" if display_name else mailbox_address
    msg["From"] = sender
    msg["To"] = to
    if cc:
        msg["Cc"] = ", ".join(cc)
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
    resp = httpx.post(
        f"https://graph.microsoft.com/v1.0/users/{mailbox_address}/sendMail",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
        content=mime, timeout=30)
    if resp.status_code != 202:
        raise HTTPException(502, f"Graph refused the send ({resp.status_code}): "
                            + resp.text[:300])
    return message_id
