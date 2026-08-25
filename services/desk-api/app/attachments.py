"""Attachment endpoints (0023) — the two ends of the pipeline the composer
and thread view use:

  POST /api/uploads              multipart file → staged row (article_id NULL,
                                 staged_by = the uploader). The composer
                                 uploads first, then posts the article with
                                 attachment_ids; tickets/articles.py links the rows and
                                 hands reply files to the mailer. Staged rows
                                 never linked are swept by the worker after a
                                 day. 20 MB/file cap here; the nginx front's
                                 client_max_body_size 25m leaves headroom for
                                 multipart overhead.
  GET  /api/attachments/{id}     authenticated download. Raster images and
                                 PDFs render inline (browser tab); everything
                                 else — including SVG, which is a script
                                 container, not a picture — downloads as an
                                 opaque file. Bytes come straight from the
                                 bytea column — one database, atomic backups.
"""
import re
import uuid

from fastapi import APIRouter, HTTPException, Request, UploadFile
from fastapi.responses import Response

from . import auth, db

router = APIRouter(prefix="/api")

MAX_BYTES = 20 * 1024 * 1024

# The stored mime is sender/uploader-chosen — it may only ever pick between
# "render inline" and "download", never inject anything. Inline is a closed
# list of script-free formats; image/svg+xml executing on the app origin with
# the agent's cookie is the stored-XSS class this fences (audit CRIT-2).
INLINE_MIMES = frozenset((
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
    "application/pdf"))
MIME_SHAPE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$")
CTRL_STRIP = re.compile(r'[\x00-\x1f\x7f"\\]')   # header-safe filename: no CR/LF/quotes


def normalize_mime(raw) -> str:
    """Lowercase, drop parameters; anything not shaped like a media type
    becomes octet-stream. The mail-worker applies the same rule at ingest."""
    mime = (raw or "").split(";")[0].strip().lower()
    return mime if MIME_SHAPE.match(mime) else "application/octet-stream"


@router.post("/uploads", status_code=201)
async def upload(file: UploadFile, request: Request):
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(422, "File exceeds the 20 MB attachment limit")
    if not data:
        raise HTTPException(422, "Empty file")
    with db.connect() as conn:
        who = auth.require(conn, request)
        auth.need(who, "reply", "note")
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO desk.attachments
                             (filename, mime_type, byte_size, content, staged_by)
                           VALUES (%s, %s, %s, %s, %s) RETURNING id""",
                        (file.filename or "attachment",
                         normalize_mime(file.content_type),
                         len(data), data, who.get("agent_id")))
            (aid,) = cur.fetchone()
    return {"id": str(aid), "name": file.filename,
            "size": len(data), "type": file.content_type}


@router.get("/attachments/{attachment_id}")
def download(attachment_id: uuid.UUID, request: Request):
    with db.connect() as conn:
        auth.require(conn, request)
        with conn.cursor() as cur:
            cur.execute("""SELECT filename, mime_type, content
                             FROM desk.attachments WHERE id = %s""",
                        (attachment_id,))
            row = cur.fetchone()
    if row is None:
        raise HTTPException(404, "No such attachment")
    filename, mime, content = row
    # serve-time is the real gate: it covers rows stored before mime
    # normalization existed, whatever their column says
    mime = normalize_mime(mime)
    inline = mime in INLINE_MIMES
    safe = CTRL_STRIP.sub("", filename or "") or "attachment"
    return Response(bytes(content),
                    media_type=mime if inline else "application/octet-stream",
                    headers={"Content-Disposition":
                             f'{"inline" if inline else "attachment"}; filename="{safe}"',
                             "X-Content-Type-Options": "nosniff",
                             "Content-Security-Policy": "default-src 'none'"})
