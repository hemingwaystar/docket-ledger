"""RFC 6238 TOTP, stdlib only. 30s step, 6 digits, SHA-1 (authenticator-app
standard). Accepts +/-1 step of clock drift."""
import base64
import hashlib
import hmac
import os
import struct
import time


def new_secret() -> str:
    return base64.b32encode(os.urandom(20)).decode().rstrip("=")


def _code(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def verify(secret: str, code: str) -> bool:
    now = int(time.time()) // 30
    code = code.strip().replace(" ", "")
    return any(hmac.compare_digest(_code(secret, now + drift), code)
               for drift in (-1, 0, 1))


def otpauth_uri(secret: str, email: str) -> str:
    return (f"otpauth://totp/Hemingway%20Tech%20Solutions:{email}"
            f"?secret={secret}&issuer=Hemingway%20Tech%20Solutions")
