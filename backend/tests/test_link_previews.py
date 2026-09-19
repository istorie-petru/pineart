"""Links auto-fetch a preview image from their own URL when they don't
already have one -- the same "unfurl" a chat app does when you paste a link.
"""

from __future__ import annotations

import pytest

from tests.conftest import make_image


def _stub_fetch(monkeypatch: pytest.MonkeyPatch, data: bytes | None) -> None:
    async def _fetch(url: str) -> bytes | None:  # noqa: ANN001
        return data

    monkeypatch.setattr("app.services.link_preview.fetch_preview_image", _fetch)


def test_creating_a_link_fetches_a_preview_image_when_available(client, monkeypatch):
    _stub_fetch(monkeypatch, make_image(seed=1))

    created = client.post(
        "/api/links", json={"title": "ArtStation", "url": "https://artstation.com/me"}
    ).json()

    assert created["cover_item_id"] is not None
    assert created["cover_url"] == f"/api/items/{created['cover_item_id']}/file/thumb"
    # The fetched image is a real item, but not one that clutters the main grid.
    item = client.get(f"/api/items/{created['cover_item_id']}").json()
    assert item["derivative_target"] == "link_cover"
    grid_ids = [i["id"] for i in client.get("/api/items").json()["items"]]
    assert created["cover_item_id"] not in grid_ids


def test_link_creation_succeeds_even_when_no_preview_is_found(client, monkeypatch):
    _stub_fetch(monkeypatch, None)

    created = client.post(
        "/api/links", json={"title": "ArtStation", "url": "https://artstation.com/me"}
    )
    assert created.status_code == 201
    assert created.json()["cover_item_id"] is None


def test_manual_upload_overrides_and_survives_a_later_url_edit(client, monkeypatch):
    _stub_fetch(monkeypatch, None)
    link = client.post(
        "/api/links", json={"title": "ArtStation", "url": "https://artstation.com/me"}
    ).json()
    assert link["cover_item_id"] is None

    uploaded = client.post(
        f"/api/links/{link['id']}/cover",
        files={"file": ("cover.png", make_image(seed=2), "image/png")},
    ).json()
    manual_cover_id = uploaded["cover_item_id"]
    assert manual_cover_id is not None

    # Even though a preview *would* now be available, editing the URL must not
    # clobber a cover the user picked themselves.
    _stub_fetch(monkeypatch, make_image(seed=3))
    patched = client.patch(
        f"/api/links/{link['id']}", json={"url": "https://artstation.com/me-again"}
    ).json()
    assert patched["cover_item_id"] == manual_cover_id


def test_editing_the_url_fetches_a_preview_if_none_was_set_yet(client, monkeypatch):
    _stub_fetch(monkeypatch, None)
    link = client.post(
        "/api/links", json={"title": "ArtStation", "url": "https://artstation.com/me"}
    ).json()
    assert link["cover_item_id"] is None

    _stub_fetch(monkeypatch, make_image(seed=4))
    patched = client.patch(
        f"/api/links/{link['id']}", json={"url": "https://artstation.com/me-again"}
    ).json()
    assert patched["cover_item_id"] is not None
