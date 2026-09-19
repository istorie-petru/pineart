from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from conftest import TEST_PASSWORD, make_image

from app.db import SessionLocal
from app.models import Session as SessionRow
from app.services import auth as auth_service


def _setup(anon_client) -> None:  # noqa: ANN001
    with SessionLocal() as db:
        token = auth_service.ensure_setup_token(db)
    assert anon_client.post(
        "/api/auth/setup", json={"password": TEST_PASSWORD, "setup_token": token}
    ).status_code == 200


def test_fresh_instance_reports_setup_required(anon_client):
    status = anon_client.get("/api/auth/status").json()
    assert status == {"authenticated": False, "setup_required": True}


def test_setup_requires_the_one_time_token(anon_client):
    """Without this, whoever reaches the port first claims the instance."""
    response = anon_client.post("/api/auth/setup", json={"password": "a-long-password", "setup_token": "guess"})
    assert response.status_code == 400
    assert anon_client.get("/api/auth/status").json()["setup_required"] is True


def test_setup_claims_the_instance_and_logs_in(anon_client):
    _setup(anon_client)
    status = anon_client.get("/api/auth/status").json()
    assert status == {"authenticated": True, "setup_required": False}
    assert anon_client.get("/api/items").status_code == 200


def test_setup_cannot_be_replayed(anon_client):
    _setup(anon_client)
    with SessionLocal() as db:
        assert auth_service.ensure_setup_token(db) is None
    response = anon_client.post(
        "/api/auth/setup", json={"password": "another-password", "setup_token": "anything"}
    )
    assert response.status_code == 400


def test_short_passwords_are_rejected(anon_client):
    with SessionLocal() as db:
        token = auth_service.ensure_setup_token(db)
    response = anon_client.post("/api/auth/setup", json={"password": "short", "setup_token": token})
    assert response.status_code == 422


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/api/items"),
        ("get", "/api/boards"),
        ("get", "/api/tags"),
        ("get", "/api/tags/graph"),
        ("get", "/api/links"),
        ("get", "/api/settings"),
        ("get", "/api/trash"),
        ("get", "/api/search?q=x"),
        ("get", "/api/export"),
        ("get", "/api/discover?q=x"),
        ("post", "/api/trash/purge"),
        ("post", "/api/boards"),
    ],
)
def test_every_api_route_is_guarded(anon_client, method, path):
    response = getattr(anon_client, method)(path)
    assert response.status_code == 401, f"{method.upper()} {path} was reachable without a session"


def test_health_stays_unauthenticated(anon_client):
    """Monitoring and `systemctl` need this without credentials."""
    body = anon_client.get("/api/health").json()
    assert body["status"] == "ok"
    assert "version" in body


def test_uploads_are_guarded(anon_client):
    response = anon_client.post(
        "/api/items", files={"file": ("a.png", make_image(), "image/png")}
    )
    assert response.status_code == 401


def test_login_logout_cycle(client):
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/items").status_code == 401

    assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
    assert client.post("/api/auth/login", json={"password": TEST_PASSWORD}).status_code == 200
    assert client.get("/api/items").status_code == 200


def test_session_cookie_is_httponly_and_lax(client):
    client.post("/api/auth/logout")
    response = client.post("/api/auth/login", json={"password": TEST_PASSWORD})
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "samesite=lax" in cookie


def test_repeated_failures_lock_out_briefly(client):
    client.post("/api/auth/logout")
    for _ in range(5):
        client.post("/api/auth/login", json={"password": "wrong"})
    response = client.post("/api/auth/login", json={"password": TEST_PASSWORD})
    assert response.status_code == 401
    assert "Too many failed attempts" in response.json()["detail"]

    auth_service.reset_throttle_for_tests()
    assert client.post("/api/auth/login", json={"password": TEST_PASSWORD}).status_code == 200


def test_expired_sessions_are_rejected_and_cleaned_up(client):
    with SessionLocal() as db:
        row = db.query(SessionRow).one()
        row.expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
        db.commit()

    assert client.get("/api/items").status_code == 401
    with SessionLocal() as db:
        assert db.query(SessionRow).count() == 0


def test_session_tokens_are_never_stored_in_the_clear(client):
    """A stolen database backup must not contain usable session credentials."""
    raw = client.cookies.get(auth_service.SESSION_COOKIE)
    with SessionLocal() as db:
        stored = db.query(SessionRow).one().token_hash
    assert stored != raw
    assert stored == auth_service.hash_token(raw)


def test_password_change_requires_the_current_password(client):
    bad = client.post(
        "/api/auth/password", json={"current_password": "nope", "new_password": "a-new-long-password"}
    )
    assert bad.status_code == 400

    good = client.post(
        "/api/auth/password",
        json={"current_password": TEST_PASSWORD, "new_password": "a-new-long-password"},
    )
    assert good.status_code == 204
    # The caller keeps working (it was reissued a session) ...
    assert client.get("/api/items").status_code == 200
    # ... and the old password no longer works.
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"password": TEST_PASSWORD}).status_code == 401
    assert client.post("/api/auth/login", json={"password": "a-new-long-password"}).status_code == 200


def test_password_change_revokes_other_sessions(client):
    with SessionLocal() as db:
        other = auth_service.create_session(db)
        assert db.query(SessionRow).count() == 2

    client.post(
        "/api/auth/password",
        json={"current_password": TEST_PASSWORD, "new_password": "a-new-long-password"},
    )
    with SessionLocal() as db:
        assert auth_service.resolve_session(db, other) is None


def test_password_hash_is_not_exposed_or_writable_through_settings(client):
    settings = client.get("/api/settings").json()
    assert not any(key.startswith("auth.") for key in settings)

    response = client.put("/api/settings", json={"values": {"auth.password_hash": "$argon2id$fake"}})
    assert response.status_code == 400
    # And the real password still works.
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"password": TEST_PASSWORD}).status_code == 200


def test_cli_password_reset_is_the_recovery_path(client):
    from app.services import auth as service

    with SessionLocal() as db:
        revoked = service.force_set_password(db, "recovered-password")
    assert revoked >= 1
    assert client.get("/api/items").status_code == 401
    assert client.post("/api/auth/login", json={"password": "recovered-password"}).status_code == 200


class TestDevSkipAuth:
    """`./run.sh --skip-auth` (2026-09-18, direct request: forgetting a
    locally-set dev password shouldn't lock you out) -- ARTBOARD_DEV_SKIP_AUTH
    bypasses require_session/auth.status entirely, but only when
    ARTBOARD_SECURE_COOKIES is also unset/false (Config.auth_bypassed's own
    comment: production always sets that to true, so the two would have to be
    deliberately misconfigured together for this to ever activate somewhere
    it shouldn't)."""

    def _set_env(self, **env: str) -> None:
        import os

        from app.config import get_config

        for key, value in env.items():
            os.environ[key] = value
        get_config.cache_clear()

    def _clear_env(self, *keys: str) -> None:
        import os

        from app.config import get_config

        for key in keys:
            os.environ.pop(key, None)
        get_config.cache_clear()

    def test_bypasses_the_guard_when_secure_cookies_is_off(self, anon_client):
        self._set_env(ARTBOARD_DEV_SKIP_AUTH="true")
        try:
            assert anon_client.get("/api/auth/status").json() == {
                "authenticated": True,
                "setup_required": False,
            }
            assert anon_client.get("/api/items").status_code == 200
        finally:
            self._clear_env("ARTBOARD_DEV_SKIP_AUTH")

    def test_does_not_apply_when_secure_cookies_is_on(self, anon_client):
        # The safety net: even with the dev flag set, a config that also
        # looks like production (ARTBOARD_SECURE_COOKIES=true) keeps the
        # guard fully enforced.
        self._set_env(ARTBOARD_DEV_SKIP_AUTH="true", ARTBOARD_SECURE_COOKIES="true")
        try:
            assert anon_client.get("/api/items").status_code == 401
            status = anon_client.get("/api/auth/status").json()
            assert status == {"authenticated": False, "setup_required": True}
        finally:
            self._clear_env("ARTBOARD_DEV_SKIP_AUTH", "ARTBOARD_SECURE_COOKIES")

    def test_off_by_default(self, anon_client):
        # No env var set at all -- the ordinary, already-covered-elsewhere
        # case, asserted here too so this class documents the full picture
        # in one place.
        assert anon_client.get("/api/items").status_code == 401
