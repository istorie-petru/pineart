"""FastAPI application entrypoint."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .config import get_config
from .db import SessionLocal, engine
from .deps import require_session
from .routers import (
    auth as auth_router,
    backup,
    boards,
    discover,
    items,
    links,
    maintenance,
    search,
    settings,
    tags,
    trash,
)
from .services import auth
from .services.queries import InvalidCursor
from .services.search import CREATE_FTS_SQL

logger = logging.getLogger("artboard")

# Read once at import time from a plain text file at the repo root, rather
# than hardcoded here, so a released build can pin an exact version by writing
# that file at build/tag time (see backend/deploy/deploy.sh) without touching
# source. Falling back to a literal keeps `./run.sh` working from a checkout
# that has no VERSION file at all (e.g. a fresh clone before any release).
_VERSION_FILE = Path(__file__).resolve().parents[2] / "VERSION"
try:
    APP_VERSION = _VERSION_FILE.read_text().strip() or "0.0.0-dev"
except OSError:
    APP_VERSION = "0.0.0-dev"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # The FTS5 virtual table is created by migration 0001, but is also ensured
    # here: it is the one piece of schema that a restore-from-.sqlite3-file can
    # arrive without, and its absence breaks search rather than failing loudly.
    with engine.begin() as connection:
        connection.execute(text(CREATE_FTS_SQL))

    with SessionLocal() as db:
        auth.purge_expired_sessions(db)
        token = auth.ensure_setup_token(db)
        if token:
            # Printed, not stored anywhere reachable over HTTP. This closes the
            # window in which anyone who can reach the port could claim a
            # freshly-started instance by setting the password first.
            logger.warning(
                "\n%s\nPineart has no password yet. To claim this instance, open the app\n"
                "and enter this one-time setup token:\n\n    %s\n\n"
                "It is valid until a password is set, and is regenerated on restart.\n%s",
                "=" * 70,
                token,
                "=" * 70,
            )
    yield


app = FastAPI(
    title="Art Board API",
    version=APP_VERSION,
    summary="Self-hosted art collection: items, tags, boards, discovery.",
    lifespan=lifespan,
)

config = get_config()
if config.cors_origin_list:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origin_list,
        # Required for the session cookie to be sent by the Vite dev server on a
        # different origin. In production the app is same-origin behind the
        # reverse proxy and CORS is not involved at all.
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Auth is applied at include time rather than per-endpoint, so a new route is
# protected by default and a forgotten decorator cannot open a hole.
guarded = [Depends(require_session)]
for module in (items, trash, boards, tags, links, settings, search, discover, backup, maintenance):
    app.include_router(module.router, dependencies=guarded)

app.include_router(auth_router.router)


@app.exception_handler(InvalidCursor)
async def _invalid_cursor(_request: Request, exc: InvalidCursor) -> JSONResponse:
    """A bad or stale cursor is a client mistake, not a server error.

    Registered once here rather than caught at each of the four call sites that
    paginate, so a new paginated endpoint gets the same behaviour for free.
    """
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/api/health", tags=["meta"])
def health() -> dict[str, str]:
    """Unauthenticated on purpose — this is what a monitor or `systemctl` checks.

    Also carries the version string: the frontend footer reads it from here
    rather than needing its own build-time injection, so "what's actually
    running" is always one already-polled request away, never stale.
    """
    return {"status": "ok", "version": APP_VERSION}
