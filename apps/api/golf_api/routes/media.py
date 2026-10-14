"""Media info and signed file delivery with HTTP Range support (video scrubbing)."""
from __future__ import annotations

import mimetypes
import os
import re
import urllib.parse

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user
from ..errors import ApiError, not_found
from ..media_urls import public_media
from ..models import Media, User
from ..security import unsign
from ..storage import StorageError, storage, user_prefix

router = APIRouter(tags=["media"])

CHUNK = 1024 * 1024
_RANGE = re.compile(r"bytes=(\d*)-(\d*)$")


def _get_media(db: Session, user: User, media_id: str) -> Media:
    m = db.get(Media, media_id)
    if m is None or m.user_id != user.id:
        raise not_found("The file")
    return m


@router.get("/media/{media_id}")
def get_media(media_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return public_media(_get_media(db, user, media_id))


@router.delete("/media/{media_id}")
def delete_media(media_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Removes a music/image asset (videos go with their project)."""
    m = _get_media(db, user, media_id)
    if m.kind == "video":
        raise ApiError(400, "not_allowed", "Videos are deleted together with the project.")
    storage().delete_prefix(m.storage_key.rsplit("/", 1)[0])
    db.delete(m)
    db.commit()
    return {"ok": True}


def _iter_file(path: str, start: int, length: int):
    with open(path, "rb") as f:
        f.seek(start)
        left = length
        while left > 0:
            buf = f.read(min(CHUNK, left))
            if not buf:
                break
            left -= len(buf)
            yield buf


@router.api_route("/m/{token}", methods=["GET", "HEAD"])
def serve(token: str, request: Request):
    """Signed URL: the token names exactly one file of one user and expires."""
    body = unsign(token)
    if body is None:
        raise ApiError(403, "link_expired", "The link has expired. Reload the page.")
    key = body.get("k", "")
    if not key.startswith(user_prefix(body.get("u", "")) + "/"):
        raise ApiError(403, "forbidden", "No access.")
    try:
        path = storage().local_path(key)
    except StorageError as exc:
        raise ApiError(400, "bad_key", "Ugyldig sti.") from exc
    if not path.is_file():
        raise not_found("The file")
    size = path.stat().st_size
    ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if path.suffix == ".json":
        ctype = "application/json"
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "Content-Type": ctype,
               "Cross-Origin-Resource-Policy": "same-site"}
    name = body.get("n", path.name)
    disp = "attachment" if body.get("d") else "inline"
    headers["Content-Disposition"] = f"{disp}; filename*=UTF-8''{urllib.parse.quote(name)}"
    rng = request.headers.get("range")
    start, end = 0, size - 1
    status = 200
    if rng:
        mt = _RANGE.match(rng.strip())
        if not mt or (not mt.group(1) and not mt.group(2)):
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        if mt.group(1):
            start = int(mt.group(1))
            end = int(mt.group(2)) if mt.group(2) else size - 1
        else:
            start = max(0, size - int(mt.group(2)))
        end = min(end, size - 1)
        if start > end or start >= size:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    length = end - start + 1
    headers["Content-Length"] = str(length)
    if request.method == "HEAD":
        return Response(status_code=status, headers=headers)
    return StreamingResponse(_iter_file(os.fspath(path), start, length), status_code=status, headers=headers)
