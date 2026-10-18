from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from ..limits import limits
from ..models import User


def geo_lookup_enabled(user: User | None) -> bool:
    """May a video's GPS position be sent to OpenStreetMap on its own (analysis, editor)?"""
    return settings().geo_lookup and (user is None or user.geo_lookup is not False)


def public_user(db: Session, user: User) -> dict[str, Any]:
    """The local user's preferences as the web app sees them."""
    return {
        "id": user.id,
        "locale": user.locale,
        "units": user.units,
        "onboardingDone": user.onboarding_done,
        "geoLookup": geo_lookup_enabled(user),
        # False when GEO_LOOKUP=0 in .env: the setting is off and can't be turned on here.
        "geoLookupAllowed": settings().geo_lookup,
        "limits": limits(),
        "createdAt": user.created_at.isoformat(),
    }
