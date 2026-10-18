"""Settings → About: version and PC, third-party notices, the diagnostics bundle, the data folder
and the update check."""
from __future__ import annotations

import os
import subprocess
import sys

from fastapi import APIRouter, Depends, Request
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import about
from ..config import app_version, settings
from ..db import get_db
from ..deps import current_user
from ..errors import ApiError
from ..local_only import local_request
from ..models import User

router = APIRouter(prefix="/about", tags=["about"])

NO_NOTICES = ("THIRD_PARTY_NOTICES.txt is generated when the Windows installer is built (scripts/third_party_notices.py).\n"
              "For a source checkout, see docs/licensing.md:\n"
              f"https://github.com/{about.REPO}/blob/main/docs/licensing.md\n")


@router.get("")
def get_about(request: Request, user: User = Depends(current_user)):
    return {**about.info(), "canOpenFolder": local_request(request)}


@router.get("/notices")
def notices():
    if about.NOTICES.exists():
        return PlainTextResponse(about.NOTICES.read_text(encoding="utf-8", errors="replace"))
    return PlainTextResponse(NO_NOTICES)


@router.get("/diagnostics")
def diagnostics(db: Session = Depends(get_db), user: User = Depends(current_user)):
    name = f"open-golf-tracer-diagnostics-{app_version()}.zip"
    return Response(about.diagnostics_zip(db), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/open-data-folder")
def open_data_folder(request: Request, user: User = Depends(current_user)):
    """Opens the data folder in Explorer/Finder on this PC. Only for a browser on the same PC:
    from another device it would open a window nobody sees."""
    if not local_request(request):
        raise ApiError(403, "local_only", "The data folder can only be opened from this PC.")
    path = str(settings().data_dir.resolve())
    if sys.platform == "win32":
        os.startfile(path)  # type: ignore[attr-defined]  # noqa: S606 – a fixed folder, no user input
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": True}


class UpdateIn(BaseModel):
    enabled: bool


@router.get("/update")
def get_update(user: User = Depends(current_user)):
    return about.update_status()


@router.put("/update")
def put_update(body: UpdateIn, user: User = Depends(current_user)):
    return about.set_update_check(body.enabled)
