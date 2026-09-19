"""Login, logout, first-run setup and password change."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import get_config
from ..db import get_db
from ..services import auth

router = APIRouter(prefix="/api/auth", tags=["auth"])


class SetupIn(BaseModel):
    password: str = Field(min_length=auth.MIN_PASSWORD_LENGTH)
    setup_token: str


class LoginIn(BaseModel):
    password: str


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=auth.MIN_PASSWORD_LENGTH)


class AuthStatus(BaseModel):
    authenticated: bool
    setup_required: bool


def _set_cookie(response: Response, token: str) -> None:
    config = get_config()
    response.set_cookie(
        auth.SESSION_COOKIE,
        token,
        max_age=int(auth.SESSION_LIFETIME.total_seconds()),
        httponly=True,
        # SameSite=Lax is what makes this app CSRF-safe without tokens: the
        # cookie is simply not sent on cross-site POST/PUT/DELETE, so a hostile
        # page cannot ride an existing session. It is still sent on ordinary
        # top-level navigation, so bookmarks keep working.
        samesite="lax",
        # Off by default so plain-HTTP development works; the systemd unit and
        # the compose file both turn it on, and production is HTTPS-only.
        secure=config.secure_cookies,
        path="/",
    )


@router.get("/status", response_model=AuthStatus)
def status(request: Request, db: Session = Depends(get_db)) -> AuthStatus:
    # dev-only skip-auth (Config.dev_skip_auth's own comment): report
    # authenticated unconditionally so the frontend goes straight into the
    # app instead of showing a login/setup screen it would then have no real
    # session to satisfy -- `require_session`'s own bypass makes every other
    # route work regardless, this just keeps the UI consistent with that.
    if get_config().auth_bypassed:
        return AuthStatus(authenticated=True, setup_required=False)
    session = auth.resolve_session(db, request.cookies.get(auth.SESSION_COOKIE))
    return AuthStatus(authenticated=session is not None, setup_required=not auth.has_password(db))


@router.post("/setup", response_model=AuthStatus)
def setup(payload: SetupIn, response: Response, db: Session = Depends(get_db)) -> AuthStatus:
    try:
        auth.set_password(db, payload.password, setup_token=payload.setup_token)
    except auth.AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _set_cookie(response, auth.create_session(db))
    return AuthStatus(authenticated=True, setup_required=False)


@router.post("/login", response_model=AuthStatus)
def login(payload: LoginIn, response: Response, db: Session = Depends(get_db)) -> AuthStatus:
    try:
        auth.verify_password(db, payload.password)
    except auth.AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    _set_cookie(response, auth.create_session(db))
    return AuthStatus(authenticated=True, setup_required=False)


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> None:
    auth.revoke_session(db, request.cookies.get(auth.SESSION_COOKIE))
    response.delete_cookie(auth.SESSION_COOKIE, path="/")


@router.post("/password", status_code=204)
def change_password(
    payload: PasswordChangeIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> None:
    """Change the password. Requires a valid session *and* the current password.

    Requiring both matters: a session alone would mean an unattended, unlocked
    browser is enough to lock the owner out.
    """
    if auth.resolve_session(db, request.cookies.get(auth.SESSION_COOKIE)) is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        auth.change_password(db, payload.current_password, payload.new_password)
    except auth.AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # change_password revoked every session, including this one; issue a fresh
    # one so the user who just changed their password is not logged out.
    _set_cookie(response, auth.create_session(db))
