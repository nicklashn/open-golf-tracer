from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..limits import limits
from ..models import User


def public_user(db: Session, user: User) -> dict[str, Any]:
    """The local user's preferences as the web app sees them."""
    return {
        "id": user.id,
        "locale": user.locale,
        "units": user.units,
        "onboardingDone": user.onboarding_done,
        "limits": limits(),
        "createdAt": user.created_at.isoformat(),
    }
