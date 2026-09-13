"""POST /api/settings/delete-all — wipes the entire collection, not just what's applied."""

from __future__ import annotations

from app.config import get_config
from app.models import Item
from conftest import upload


def test_delete_all_removes_items_boards_tags_and_files(client, db):
    item = upload(client, tags="landscape, study")["item"]
    board = client.post("/api/boards", json={"name": "Studies"}).json()
    stored = get_config().data_dir / db.get(Item, item["id"]).storage_path

    response = client.post("/api/settings/delete-all")
    assert response.status_code == 200, response.text

    assert client.get("/api/items").json()["total"] == 0
    assert client.get(f"/api/items/{item['id']}").status_code == 404
    assert client.get(f"/api/boards/{board['id']}").status_code == 404
    assert client.get("/api/tags").json() == []
    assert not stored.exists()


def test_delete_all_clears_profile_avatar_and_banner(client):
    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 400, "h": 400, "target": "avatar"},
    )
    assert client.get("/api/settings").json()["profile.avatar_item_id"] is not None

    client.post("/api/settings/delete-all")

    settings = client.get("/api/settings").json()
    assert settings["profile.avatar_item_id"] is None
    assert settings["profile.banner_item_id"] is None


def test_delete_all_leaves_other_settings_untouched(client):
    client.put("/api/settings", json={"values": {"appearance.theme": "dark"}})
    upload(client, tags="x")

    client.post("/api/settings/delete-all")

    assert client.get("/api/settings").json()["appearance.theme"] == "dark"


def test_delete_all_clears_search_index(client):
    item = upload(client, tags="haikyu")["item"]
    assert client.get("/api/items", params={"q": "tag:haikyu"}).json()["total"] == 1

    client.post("/api/settings/delete-all")

    assert client.get("/api/items", params={"q": "haikyu"}).json()["total"] == 0
    assert item["id"] not in [i["id"] for i in client.get("/api/items").json()["items"]]
