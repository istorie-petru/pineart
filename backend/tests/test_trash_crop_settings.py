from __future__ import annotations

from conftest import make_image, upload

from app.config import get_config
from app.services import images


def test_soft_delete_hides_from_feed_and_restore_brings_it_back(client):
    item = upload(client)["item"]
    client.delete(f"/api/items/{item['id']}")

    assert client.get("/api/items").json()["total"] == 0
    trashed = client.get("/api/trash").json()
    assert [i["id"] for i in trashed["items"]] == [item["id"]]
    assert trashed["items"][0]["deleted_at"] is not None

    client.post(f"/api/items/{item['id']}/restore")
    assert client.get("/api/items").json()["total"] == 1


def test_purge_respects_retention_window(client):
    item = upload(client)["item"]
    client.delete(f"/api/items/{item['id']}")

    # Default retention is 30 days, so a just-deleted item must survive.
    assert client.post("/api/trash/purge").json()["purged"] == 0
    assert client.get("/api/trash").json()["total"] == 1

    assert client.post("/api/trash/purge", params={"force": True}).json()["purged"] == 1
    assert client.get("/api/trash").json()["total"] == 0
    assert client.get(f"/api/items/{item['id']}").status_code == 404


def test_purge_removes_files_from_disk(client):
    item = upload(client)["item"]
    directory = images.storage_dir_for(item["hash"])
    stored = sorted(p.name for p in directory.glob(f"{item['hash']}*"))
    assert stored == [
        f"{item['hash']}.webp",
        f"{item['hash']}_display.webp",
        f"{item['hash']}_thumb.webp",
    ]

    client.delete(f"/api/items/{item['id']}")
    client.post("/api/trash/purge", params={"force": True})

    assert list(directory.glob(f"{item['hash']}*")) == []


def test_reuploading_a_trashed_file_restores_it(client):
    data = make_image()
    item = upload(client, data=data)["item"]
    client.delete(f"/api/items/{item['id']}")

    again = upload(client, data=data)
    assert again["created"] is False
    assert again["item"]["is_deleted"] is False
    assert client.get("/api/items").json()["total"] == 1


def test_crop_creates_a_derived_item_and_leaves_the_source_intact(client):
    source = upload(client, image_kwargs={"size": (800, 800)})["item"]
    derived = client.post(
        f"/api/items/{source['id']}/crop", json={"x": 100, "y": 100, "w": 400, "h": 400}
    ).json()

    assert derived["id"] != source["id"]
    assert derived["parent_item_id"] == source["id"]
    assert (derived["width"], derived["height"]) == (400, 400)

    # The artwork now *displays* the crop, but the original file is untouched and
    # still there as a version — cropping is non-destructive, not reversible-by-
    # accident.
    versions = client.get(f"/api/items/{source['id']}/versions").json()["versions"]
    original = next(v for v in versions if v["id"] == source["id"])
    assert (original["width"], original["height"]) == (800, 800)
    assert client.get(f"/api/items/{source['id']}/file/display").status_code == 200


def test_avatar_crop_wires_itself_into_settings(client):
    source = upload(client, image_kwargs={"size": (800, 800)})["item"]
    derived = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 300, "h": 300, "target": "avatar"},
    ).json()

    assert derived["derivative_target"] == "avatar"
    settings = client.get("/api/settings").json()
    assert settings["profile.avatar_item_id"] == derived["id"]
    assert settings["profile.avatar_url"] == f"/api/items/{derived['id']}/file/display"


def test_board_cover_crop_sets_the_board_cover(client):
    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    board = client.post("/api/boards", json={"name": "Covered"}).json()

    derived = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 600, "h": 400, "target": "board_cover", "board_id": board["id"]},
    ).json()

    updated = client.get(f"/api/boards/{board['id']}").json()
    assert updated["cover_item_id"] == derived["id"]
    assert updated["cover_url"] == f"/api/items/{derived['id']}/file/display"


def test_crop_enforces_the_target_aspect_ratio_server_side(client):
    source = upload(client, image_kwargs={"size": (800, 800)})["item"]
    wrong = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 400, "h": 100, "target": "avatar"},
    )
    assert wrong.status_code == 400
    assert "1.0:1" in wrong.json()["detail"]


def test_crop_outside_the_image_is_rejected(client):
    source = upload(client, image_kwargs={"size": (400, 400)})["item"]
    response = client.post(
        f"/api/items/{source['id']}/crop", json={"x": 900, "y": 900, "w": 100, "h": 100}
    )
    assert response.status_code == 400


def test_settings_round_trip_and_validation(client):
    defaults = client.get("/api/settings").json()
    assert defaults["collection.page_size"] == 40
    assert defaults["discovery.enabled"] is False

    updated = client.put(
        "/api/settings",
        json={"values": {"collection.page_size": 12, "appearance.accent_color": "#336699"}},
    ).json()
    assert updated["collection.page_size"] == 12
    assert client.get("/api/settings").json()["appearance.accent_color"] == "#336699"

    bad = client.put("/api/settings", json={"values": {"collection.page_size": 9999}})
    assert bad.status_code == 400

    # bool is a subclass of int in Python; the validator must not let it through.
    assert client.put(
        "/api/settings", json={"values": {"collection.page_size": True}}
    ).status_code == 400

    assert client.put(
        "/api/settings", json={"values": {"collection.default_sort": "colour"}}
    ).status_code == 400


def test_tag_graph_physics_defaults_and_round_trip(client):
    defaults = client.get("/api/settings").json()
    assert defaults["tagGraph.charge_strength"] == -420
    assert defaults["tagGraph.link_distance"] == 110
    assert defaults["tagGraph.link_strength"] == 0.2
    assert defaults["tagGraph.center_strength"] == 0.1

    updated = client.put(
        "/api/settings",
        json={
            "values": {
                "tagGraph.charge_strength": -300,
                "tagGraph.link_distance": 60,
                "tagGraph.link_strength": 0.8,
                "tagGraph.center_strength": 0.4,
            }
        },
    ).json()
    assert updated["tagGraph.charge_strength"] == -300
    assert updated["tagGraph.link_distance"] == 60
    assert updated["tagGraph.link_strength"] == 0.8
    assert updated["tagGraph.center_strength"] == 0.4


def test_tag_graph_physics_rejects_out_of_range_values(client):
    for key, bad in (
        ("tagGraph.charge_strength", 5),  # must be negative
        ("tagGraph.charge_strength", -5000),
        ("tagGraph.link_distance", 5),
        ("tagGraph.link_distance", 1000),
        ("tagGraph.link_strength", -0.1),
        ("tagGraph.link_strength", 10),
        ("tagGraph.center_strength", -0.1),
        ("tagGraph.center_strength", 10),
    ):
        response = client.put("/api/settings", json={"values": {key: bad}})
        assert response.status_code == 400, (key, bad)


def test_page_size_setting_drives_default_pagination(client):
    for i in range(5):
        upload(client, image_kwargs={"seed": i, "size": (300 + i, 200)})
    client.put("/api/settings", json={"values": {"collection.page_size": 2}})

    page = client.get("/api/items").json()
    assert len(page["items"]) == 2 and page["total"] == 5


def test_preserve_original_bytes_skips_webp_conversion(client):
    client.put("/api/settings", json={"values": {"storage.preserve_original_bytes": True}})
    item = upload(client, image_kwargs={"seed": 3})["item"]

    assert item["mime_type"] == "image/png"
    stored = images.storage_dir_for(item["hash"]) / f"{item['hash']}.png"
    assert stored.exists()
    # Derivatives are still WebP — the override is about the *original* only.
    assert images.derivative_path(str(stored.relative_to(get_config().data_dir)), "thumb").exists()


def test_links_crud(client):
    created = client.post(
        "/api/links", json={"title": "ArtStation", "url": "https://artstation.com", "icon": "brush"}
    ).json()
    assert created["position"] == 0

    client.patch(f"/api/links/{created['id']}", json={"title": "ArtStation ★"})
    assert client.get("/api/links").json()[0]["title"] == "ArtStation ★"

    assert client.post("/api/links", json={"title": "Bad", "url": "javascript:alert(1)"}).status_code == 422

    assert client.delete(f"/api/links/{created['id']}").status_code == 204
    assert client.get("/api/links").json() == []


def test_discovery_endpoints_are_gated_by_the_setting(client):
    """Feed is hidden until Discovery is configured; the API enforces the same rule."""
    assert client.get("/api/discover", params={"q": "cats"}).status_code == 409

    client.put("/api/settings", json={"values": {"discovery.enabled": True}})
    assert client.get("/api/discover", params={"q": "cats"}).status_code == 409  # no URL yet


def test_discover_save_refuses_loopback_urls(client):
    client.put(
        "/api/settings",
        json={"values": {"discovery.enabled": True, "discovery.searxng_url": "http://127.0.0.1:8080"}},
    )
    response = client.post(
        "/api/discover/save", json={"image_url": "http://127.0.0.1:9000/secret.png"}
    )
    assert response.status_code == 400
    assert "private or loopback" in response.json()["detail"]
