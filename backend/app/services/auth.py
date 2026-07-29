"""Single-user authentication — architecture §9c.

Three decisions worth stating, because each rules out a simpler alternative:

1. **Server-side sessions, not a stateless signed cookie.** A signed cookie
   cannot be revoked: "log out everywhere" and "someone stole my laptop" both
   require waiting for the expiry. A session row can be deleted.

2. **Session tokens are stored hashed.** The cookie holds the token; the
   database holds its SHA-256. A leaked database backup therefore does not hand
   an attacker a set of live sessions. SHA-256 rather than argon2 here is
   deliberate — the token is 256 bits of CSPRNG output, so it has no guessable
   structure to slow-hash, and this runs on every request.

3. **First-run setup is gated by a one-time token printed to the log.** Without
   it, the window between "service starts" and "owner sets a password" is a
   window in which anyone who can reach the port claims the instance. Several
   well-known self-hosted apps leave that window open; the cost of closing it is
   one log line to copy.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..models import Session as SessionRow
from . import settings_store

PASSWORD_HASH_KEY = "auth.password_hash"
SESSION_COOKIE = "artboard_session"
SESSION_LIFETIME = timedelta(days=30)
MIN_PASSWORD_LENGTH = 10

_hasher = PasswordHasher()

# One-time setup token, generated per process when no password exists yet.
_setup_token: str | None = None

# Login throttling. In-memory on purpose: this is a single-user, single-process
# app, and persisting failed-attempt counters would mean a database write on
# every wrong keystroke. A restart clears it, which is an accepted trade —
# an attacker who can restart the service has already won.
_failed_attempts = 0
_locked_until = 0.0
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_SECONDS = 60


class AuthError(Exception):
    """Login refused: wrong password, or too many attempts."""


def has_password(db: DbSession) -> bool:
    return bool(settings_store.get(db, PASSWORD_HASH_KEY))


def ensure_setup_token(db: DbSession) -> str | None:
    """Return the one-time setup token, generating it on first call.

    Returns None once a password exists — the token is meaningless after that.
    """
    global _setup_token
    if has_password(db):
        _setup_token = None
        return None
    if _setup_token is None:
        _setup_token = secrets.token_urlsafe(24)
    return _setup_token


def set_password(db: DbSession, password: str, *, setup_token: str | None = None) -> None:
    """Create or replace the password.

    When no password exists yet this is the claim-the-instance path and requires
    the one-time token. Once one exists, changing it goes through
    `change_password`, which requires the current password instead.
    """
    global _setup_token
    if has_password(db):
        raise AuthError("A password is already set")
    expected = ensure_setup_token(db)
    if not setup_token or not expected or not secrets.compare_digest(setup_token, expected):
        raise AuthError("Invalid or missing setup token")
    _validate_password(password)
    settings_store.set_raw(db, PASSWORD_HASH_KEY, _hasher.hash(password))
    _setup_token = None


def change_password(db: DbSession, current: str, new: str) -> None:
    stored = settings_store.get(db, PASSWORD_HASH_KEY)
    if not stored:
        raise AuthError("No password is set yet")
    try:
        _hasher.verify(str(stored), current)
    except (VerifyMismatchError, InvalidHashError) as exc:
        raise AuthError("Current password is incorrect") from exc
    _validate_password(new)
    settings_store.set_raw(db, PASSWORD_HASH_KEY, _hasher.hash(new))
    # Every existing session is invalidated: a password change is the one action
    # whose whole point may be locking someone else out.
    db.query(SessionRow).delete()
    db.commit()


def force_set_password(db: DbSession, password: str) -> int:
    """Set the password with no checks and revoke every session.

    The recovery path, reachable only from the machine itself (`app.cli
    set-password`). It asks for no current password on purpose: whoever can run
    it can already read the database file, so a check would be theatre.
    Returns the number of sessions revoked.
    """
    _validate_password(password)
    settings_store.set_raw(db, PASSWORD_HASH_KEY, _hasher.hash(password))
    revoked = db.query(SessionRow).delete()
    db.commit()
    return int(revoked)


def _validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise AuthError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")


def verify_password(db: DbSession, password: str) -> None:
    """Check a login attempt, applying throttling. Raises AuthError on failure."""
    global _failed_attempts, _locked_until

    if time.monotonic() < _locked_until:
        remaining = int(_locked_until - time.monotonic()) + 1
        raise AuthError(f"Too many failed attempts — try again in {remaining}s")

    stored = settings_store.get(db, PASSWORD_HASH_KEY)
    if not stored:
        raise AuthError("No password is set yet")

    try:
        _hasher.verify(str(stored), password)
    except (VerifyMismatchError, InvalidHashError) as exc:
        _failed_attempts += 1
        if _failed_attempts >= MAX_FAILED_ATTEMPTS:
            _locked_until = time.monotonic() + LOCKOUT_SECONDS
            _failed_attempts = 0
        raise AuthError("Incorrect password") from exc

    _failed_attempts = 0
    # argon2 parameters change between library versions; rehashing on login keeps
    # a long-lived install's hash current without asking the user to do anything.
    if _hasher.check_needs_rehash(str(stored)):
        settings_store.set_raw(db, PASSWORD_HASH_KEY, _hasher.hash(password))


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db: DbSession) -> str:
    token = secrets.token_urlsafe(32)
    db.add(
        SessionRow(
            token_hash=hash_token(token),
            created_at=datetime.now(timezone.utc),
            expires_at=datetime.now(timezone.utc) + SESSION_LIFETIME,
        )
    )
    db.commit()
    return token


def resolve_session(db: DbSession, token: str | None) -> SessionRow | None:
    if not token:
        return None
    row = db.scalar(select(SessionRow).where(SessionRow.token_hash == hash_token(token)))
    if row is None:
        return None
    if row.expires_at < datetime.now(timezone.utc).replace(tzinfo=None):
        db.delete(row)
        db.commit()
        return None
    return row


def revoke_session(db: DbSession, token: str | None) -> None:
    if not token:
        return
    row = db.scalar(select(SessionRow).where(SessionRow.token_hash == hash_token(token)))
    if row is not None:
        db.delete(row)
        db.commit()


def purge_expired_sessions(db: DbSession) -> int:
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = db.scalars(select(SessionRow).where(SessionRow.expires_at < cutoff)).all()
    for row in rows:
        db.delete(row)
    db.commit()
    return len(rows)


def reset_throttle_for_tests() -> None:
    """Test hook — the throttle is process state, so tests must be able to clear it."""
    global _failed_attempts, _locked_until
    _failed_attempts = 0
    _locked_until = 0.0
