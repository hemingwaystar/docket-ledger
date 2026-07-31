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
  GET  /api/attachments/{id}     authenticated download. Images and PDFs
                                 render inline (browser tab); everything else
                                 downloads. Bytes come straight from the
                                 bytea column — one database, atomic backups.
"""
import uuid

from fastapi import APIRouter, HTTPException, Request, UploadFile
from fastapi.responses import Response

from . import auth, db

router = APIRouter(prefix="/api")

MAX_BYTES = 20 * 1024 * 1024


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
                         file.content_type or "application/octet-stream",
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
    disposition = "inline" if (mime or "").startswith(("image/", "application/pdf")) \
        else "attachment"
    safe = (filename or "attachment").replace('"', "")
    return Response(bytes(content), media_type=mime or "application/octet-stream",
                    headers={"Content-Disposition":
                             f'{disposition}; filename="{safe}"'})
