"""Envelope encryption with the file-mounted KEK (secrets/README.md).
AES-256-GCM; blobs are nonce(12) || ciphertext. Used for TOTP secrets now,
Graph/Entra/provider credentials next."""
import base64
import os
import pathlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _kek() -> bytes:
    raw = pathlib.Path(os.environ["KEK_FILE"]).read_text().strip()
    return base64.b64decode(raw)


def seal(plaintext: bytes) -> bytes:
    nonce = os.urandom(12)
    return nonce + AESGCM(_kek()).encrypt(nonce, plaintext, None)


def open_(blob: bytes) -> bytes:
    blob = bytes(blob)
    return AESGCM(_kek()).decrypt(blob[:12], blob[12:], None)
