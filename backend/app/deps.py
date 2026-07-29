"""Shared FastAPI dependencies."""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .db import get_db
from .services import auth


def require_session(request: Request, db: Session = Depends(get_db)) -> None:
    """Reject the request unless it carries a valid session cookie.

    Applied to every API router except /api/auth and /api/health. Attaching it at
    router-include time rather than per-endpoint is deliberate: a new endpoint is
    then protected by default, and forgetting a decorator cannot silently open a
    hole.
    """
    token = request.cookies.get(auth.SESSION_COOKIE)
    if auth.resolve_session(db, token) is None:
        # 401 with this body lets the frontend distinguish "log in" from "set up
        # a password for the first time" without a second round trip.
        raise HTTPException(
            status_code=401,
            detail="Not authenticated",
            headers={"X-Artboard-Setup-Required": "1" if not auth.has_password(db) else "0"},
        )
