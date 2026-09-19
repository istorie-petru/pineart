"""Test fixtures.

The data directory is set before `app` is imported: config is cached and the
SQLAlchemy engine is built at import time, so an env var set later would be
ignored and the suite would run against the developer's real database.
"""

from __future__ import annotations

import io
import os
import random
import tempfile
from pathlib import Path

import pytest

_TMP_DIR = tempfile.mkdtemp(prefix="artboard-tests-")
os.environ["ARTBOARD_DATA_DIR"] = _TMP_DIR
os.environ["ARTBOARD_CORS_ORIGINS"] = ""

from alembic import command  # noqa: E402
from alembic.config import Config as AlembicConfig  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> None:
    """Apply the real Alembic migration, not metadata.create_all.

    This makes the migration itself part of the test surface: a migration that
    drifts from the models would otherwise only be discovered on a real upgrade.
    """
    alembic_cfg = AlembicConfig(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    alembic_cfg.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    command.upgrade(alembic_cfg, "head")


@pytest.fixture(autouse=True)
def clean_tables(migrated_database):  # noqa: ANN001
    yield
    # The password hash and the setup token both live outside the request cycle,
    # so they have to be reset between tests or the second test to run would find
    # an instance that is already claimed.
    from app.services import auth as auth_service

    auth_service._setup_token = None
    auth_service.reset_throttle_for_tests()
    from sqlalchemy import text

    # One checked-out connection, not two `engine.begin()` blocks: the pool
    # holds more than one physical SQLite connection, so two separate
    # `engine.begin()` calls can each grab a *different* one — the "ON" then
    # lands on a connection nobody just turned "OFF", while the one that's
    # actually left with FK enforcement off goes back into the pool and gets
    # handed to a later test. That is exactly the bug this used to have: a
    # rule row whose category had just been deleted would still be sitting in
    # `tag_graph_rules` on the next request served by that connection, because
    # the ON DELETE CASCADE never re-armed. Explicit `.commit()` calls between
    # statements (rather than one `.begin()`) are what let "ON" apply
    # immediately after "OFF" on this same connection — sqlite3's stdlib
    # driver only opens an implicit transaction before DML, not before
    # PRAGMA, so sharing one transaction across both would run "ON" after that
    # implicit BEGIN and silently no-op (SQLite: "this pragma is a no-op
    # within a transaction").
    with engine.connect() as connection:
        connection.execute(text("PRAGMA foreign_keys=OFF"))
        connection.commit()
        for table in reversed(Base.metadata.sorted_tables):
            connection.execute(text(f"DELETE FROM {table.name}"))
        connection.execute(text("DELETE FROM items_fts"))
        connection.commit()
        connection.execute(text("PRAGMA foreign_keys=ON"))
        connection.commit()


@pytest.fixture(autouse=True)
def no_real_link_previews(monkeypatch: pytest.MonkeyPatch):
    """`POST/PATCH /api/links` best-effort-fetches a preview image from the
    link's own URL (services/link_preview.py) -- without this, every test
    that creates a link would fire a real outbound HTTP request, which is
    slow and flaky in a sandboxed/offline test run. Tests that specifically
    exercise the fetch override this with their own monkeypatch.
    """

    async def _no_preview(url: str) -> bytes | None:  # noqa: ANN001
        return None

    monkeypatch.setattr("app.services.link_preview.fetch_preview_image", _no_preview)


TEST_PASSWORD = "correct-horse-battery"


@pytest.fixture
def anon_client() -> TestClient:
    """A client with no session — for testing the auth boundary itself."""
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def client(anon_client: TestClient) -> TestClient:
    """A logged-in client.

    Every test that touches the API goes through the real setup + login flow
    rather than bypassing auth with a fixture-injected session. That way the
    login path is exercised by the whole suite, not only by the auth tests, and
    an accidental change to the guard breaks loudly everywhere.
    """
    from app.services import auth as auth_service

    auth_service.reset_throttle_for_tests()
    with SessionLocal() as db:
        token = auth_service.ensure_setup_token(db)
    response = anon_client.post(
        "/api/auth/setup", json={"password": TEST_PASSWORD, "setup_token": token}
    )
    assert response.status_code == 200, response.text
    return anon_client


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def make_image(
    color: tuple[int, int, int] = (200, 30, 40),
    size: tuple[int, int] = (600, 400),
    fmt: str = "PNG",
    seed: int = 0,
) -> bytes:
    """Deterministic test image: a gradient plus `seed`-driven shapes.

    Two properties this fixture has to have, and why:

    * Flat colour blocks are useless for pHash. The DCT of a uniform image is
      degenerate, and on such images a resized copy can score *further* from its
      source than an unrelated image does — the near-duplicate test would then be
      measuring noise.
    * pHash is a *structural*, luminance-based hash, so recolouring the same
      layout is legitimately a near-duplicate. Distinct images therefore have to
      differ in layout, which is what `seed` controls. All shape coordinates are
      fractions of the image size, so scaling the same seed produces the same
      structure at a different resolution — exactly the "re-saved copy" case.
    """
    width, height = size
    img = Image.new("RGB", size)
    draw = ImageDraw.Draw(img)
    inverse = tuple(255 - c for c in color)

    for x in range(width):
        f = x / max(1, width - 1)
        draw.line(
            [(x, 0), (x, height)],
            fill=tuple(int(c * (1 - f) + i * f) for c, i in zip(color, inverse)),
        )

    rng = random.Random(seed)
    for _ in range(4):
        x0, y0 = rng.uniform(0, 0.6), rng.uniform(0, 0.6)
        x1, y1 = x0 + rng.uniform(0.15, 0.35), y0 + rng.uniform(0.15, 0.35)
        box = [width * x0, height * y0, width * x1, height * y1]
        shape = draw.ellipse if rng.random() < 0.5 else draw.rectangle
        shape(box, fill=inverse if rng.random() < 0.5 else color)

    buffer = io.BytesIO()
    img.save(buffer, fmt)
    return buffer.getvalue()


def make_solid_image(color: tuple[int, int, int], size: tuple[int, int] = (400, 400)) -> bytes:
    """An image whose dominant colour really is `color`.

    `make_image` gradients from a colour towards its *inverse*, so a picture
    seeded "blue" can easily come out gold-dominant — fine for pHash tests, which
    care about structure, and useless for colour-filter tests, which care about
    exactly the thing that generator randomises. A small off-tint block keeps the
    file from being a single flat colour without shifting the dominant one.
    """
    img = Image.new("RGB", size, color)
    draw = ImageDraw.Draw(img)
    shade = tuple(max(0, min(255, int(c * 0.75))) for c in color)
    draw.rectangle([0, 0, size[0] // 5, size[1] // 5], fill=shade)
    buffer = io.BytesIO()
    img.save(buffer, "PNG")
    return buffer.getvalue()


def upload(client: TestClient, **kwargs) -> dict:
    data = kwargs.pop("data", None) or make_image(**kwargs.pop("image_kwargs", {}))
    form = {k: v for k, v in kwargs.items() if v is not None}
    response = client.post(
        "/api/items", files={"file": ("test.png", data, "image/png")}, data=form
    )
    assert response.status_code == 201, response.text
    return response.json()
