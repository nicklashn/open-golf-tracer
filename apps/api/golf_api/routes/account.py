"""Settings of the local user (language, units), saved tracer styles and the data export."""
from __future__ import annotations

import io
import json
import zipfile

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user
from ..errors import ApiError
from ..models import CustomStyle, Export, Media, Project, User
from .common import public_user

router = APIRouter(prefix="/account", tags=["account"])


class ProfileIn(BaseModel):
    locale: str | None = Field(None, pattern="^(da|en)$")
    units: str | None = Field(None, pattern="^(m|yd)$")
    onboarding_done: bool | None = None
    geo_lookup: bool | None = None


class StyleIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    style: dict


@router.get("")
def get_account(db: Session = Depends(get_db), user: User = Depends(current_user)):
    return {"user": public_user(db, user)}


@router.patch("")
def update_profile(body: ProfileIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if body.locale is not None:
        user.locale = body.locale
    if body.units is not None:
        user.units = body.units
    if body.onboarding_done is not None:
        user.onboarding_done = body.onboarding_done
    if body.geo_lookup is not None:
        user.geo_lookup = body.geo_lookup
    db.commit()
    return {"user": public_user(db, user)}


@router.get("/styles")
def list_styles(db: Session = Depends(get_db), user: User = Depends(current_user)):
    rows = db.scalars(select(CustomStyle).where(CustomStyle.user_id == user.id).order_by(CustomStyle.created_at)).all()
    return {"styles": [{"id": s.id, "name": s.name, "style": s.style} for s in rows]}


@router.post("/styles")
def create_style(body: StyleIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if len(json.dumps(body.style)) > 4000:
        raise ApiError(413, "too_large", "The style is too large.")
    s = CustomStyle(user_id=user.id, name=body.name.strip(), style=body.style)
    db.add(s)
    db.commit()
    return {"id": s.id, "name": s.name, "style": s.style}


@router.delete("/styles/{style_id}")
def delete_style(style_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    s = db.get(CustomStyle, style_id)
    if s is None or s.user_id != user.id:
        raise ApiError(404, "not_found", "The style was not found.")
    db.delete(s)
    db.commit()
    return {"ok": True}


@router.get("/export")
def export_my_data(db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Everything stored in the database as JSON in a zip (videos are listed, not included)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("settings.json", json.dumps(public_user(db, user), indent=2, ensure_ascii=False))
        projects = db.scalars(select(Project).where(Project.user_id == user.id)).all()
        for p in projects:
            z.writestr(f"projects/{p.id}.json", json.dumps({"id": p.id, "name": p.name, "document": p.document,
                                                            "createdAt": p.created_at.isoformat()}, indent=2, ensure_ascii=False))
        media = db.scalars(select(Media).where(Media.user_id == user.id)).all()
        z.writestr("media.json", json.dumps([{"id": m.id, "filename": m.filename, "size": m.size, "kind": m.kind, "probe": m.probe,
                                              "createdAt": m.created_at.isoformat()} for m in media], indent=2, ensure_ascii=False))
        exports = db.scalars(select(Export).where(Export.user_id == user.id)).all()
        z.writestr("exports.json", json.dumps([{"id": e.id, "project": e.project_name, "settings": e.settings, "status": e.status,
                                                "createdAt": e.created_at.isoformat()} for e in exports], indent=2, ensure_ascii=False))
        z.writestr("README.txt", "Dine data fra Open Golf Tracer. Videoerne kan hentes fra hvert projekt i appen.\n"
                                 "Your data from Open Golf Tracer. Videos can be downloaded from each project in the app.\n")
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": 'attachment; filename="open-golf-tracer-data.zip"'})
