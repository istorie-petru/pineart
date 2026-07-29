"""POST /api/settings/reset — untag everything, clear covers, keep the rest."""

from __future__ import annotations

from conftest import upload


def test_reset_untags_items_but_keeps_tag_definitions(client):
    item = upload(client, tags="landscape, study")["item"]
    assert {t["name"] for t in item["tags"]} == {"landscape", "study"}

    client.post("/api/settings/reset")

    refreshed = client.get(f"/api/items/{item['id']}").json()
    assert refreshed["tags"] == []
    # The tags themselves still exist, ready to reapply.
    assert {t["name"] for t in client.get("/api/tags").json()} == {"landscape", "study"}


def test_reset_clears_profile_avatar_and_banner(client):
    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 400, "h": 400, "target": "avatar"},
    )
    assert client.get("/api/settings").json()["profile.avatar_item_id"] is not None

    client.post("/api/settings/reset")

    settings = client.get("/api/settings").json()
    assert settings["profile.avatar_item_id"] is None
    assert settings["profile.banner_item_id"] is None


def test_reset_clears_every_board_cover(client):
    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    board = client.post("/api/boards", json={"name": "Covered"}).json()
    crop = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 600, "h": 400, "target": "board_cover", "board_id": board["id"]},
    )
    assert crop.status_code == 201, crop.text
    assert client.get(f"/api/boards/{board['id']}").json()["cover_item_id"] is not None

    client.post("/api/settings/reset")

    assert client.get(f"/api/boards/{board['id']}").json()["cover_item_id"] is None


def test_reset_does_not_touch_items_or_boards_themselves(client):
    upload(client, tags="x")
    upload(client, tags="y")
    board = client.post("/api/boards", json={"name": "Stays"}).json()

    before_total = client.get("/api/items").json()["total"]

    client.post("/api/settings/reset")

    assert client.get("/api/items").json()["total"] == before_total
    assert client.get(f"/api/boards/{board['id']}").json()["name"] == "Stays"


def test_reset_untagged_items_still_findable_by_search(client):
    """The FTS index has to drop the tag text too, not just the item_tags row,
    or a stale tag would keep matching a search after reset."""
    item = upload(client, tags="haikyu")["item"]
    assert client.get("/api/items", params={"q": "tag:haikyu"}).json()["total"] == 1

    client.post("/api/settings/reset")

    assert client.get("/api/items", params={"q": "tag:haikyu"}).json()["total"] == 0
    # Free-text search for the (no longer applied) tag word also stops
    # matching, confirming the FTS row was actually rewritten.
    assert client.get("/api/items", params={"q": "haikyu"}).json()["total"] == 0
    assert item["id"] in [i["id"] for i in client.get("/api/items").json()["items"]]
