"""Database engine and session handling.

Deliberately *synchronous* SQLAlchemy (see architecture §1 implementation notes):
FastAPI runs sync dependencies in a thread pool, which is simpler and more mature
than the async SQLite driver path. Only genuinely network-bound work (the SearXNG
proxy, remote image downloads) uses async.
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_config

_config = get_config()

# check_same_thread=False is required because FastAPI hands sessions to worker
# threads; each request still gets its own Session, so this is safe.
engine: Engine = create_engine(
    _config.resolved_database_url,
    connect_args={"check_same_thread": False},
    future=True,
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_connection, _record) -> None:  # noqa: ANN001
    """WAL + foreign keys, applied per-connection.

    WAL lets readers proceed during a write, which matters here because thumbnail
    generation holds a transaction open while the feed is being browsed.
    foreign_keys is OFF by default in SQLite and must be enabled per connection,
    otherwise every FK in the schema is documentation rather than a constraint.
    """
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
