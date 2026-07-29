"""Avatar/banner/cover crops live beside the photo they were cut from."""

from __future__ import annotations

from pathlib import Path

from conftest import upload

from app.config import get_config
from app.services import images


def test_avatar_is_stored_next_to_its_source(client, db):
    from app.models import Item

    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    derived = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 400, "h": 400, "target": "avatar"},
    ).json()

    source_row = db.get(Item, source["id"])
    derived_row = db.get(Item, derived["id"])
    source_file = get_config().data_dir / source_row.storage_path
    derived_file = get_config().data_dir / derived_row.storage_path

    # Same directory, and named after the original rather than after its own hash.
    assert derived_file.parent == source_file.parent
    assert derived_file.stem == f"{source_file.stem}_avatar"
    assert derived_file.exists()

    # Its thumbnails sit alongside too, and are what the API serves.
    for kind in ("thumb", "display"):
        assert images.derivative_path(derived_row.storage_path, kind).exists()
        assert client.get(f"/api/items/{derived['id']}/file/{kind}").status_code == 200


def test_banner_and_cover_use_the_same_scheme(client, db):
    from app.models import Item

    source = upload(client, image_kwargs={"size": (1200, 1200)})["item"]
    board = client.post("/api/boards", json={"name": "Covered"}).json()

    banner = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 640, "h": 200, "target": "banner"},
    ).json()
    cover = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 600, "h": 400, "target": "board_cover", "board_id": board["id"]},
    ).json()

    source_stem = Path(db.get(Item, source["id"]).storage_path).stem
    assert Path(db.get(Item, banner["id"]).storage_path).stem == f"{source_stem}_banner"
    assert Path(db.get(Item, cover["id"]).storage_path).stem == f"{source_stem}_board_cover"


def test_recropping_the_same_source_keeps_one_item(client):
    """Setting your avatar twice should not litter the collection with orphans."""
    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    before = client.get("/api/items").json()["total"]

    first = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 400, "h": 400, "target": "avatar"},
    ).json()
    second = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 100, "y": 100, "w": 300, "h": 300, "target": "avatar"},
    ).json()

    assert second["id"] == first["id"], "the avatar item id should be stable"
    assert second["hash"] != first["hash"], "but its contents should have been replaced"
    assert second["width"] == 300
    # A profile crop is an asset of the artwork, not a picture in the
    # collection, so the feed is unchanged by making one.
    assert client.get("/api/items").json()["total"] == before

    settings = client.get("/api/settings").json()
    assert settings["profile.avatar_item_id"] == second["id"]


def test_profile_crops_never_appear_in_the_feed(client):
    source = upload(client, image_kwargs={"size": (1200, 1200)})["item"]
    board = client.post("/api/boards", json={"name": "B"}).json()
    for payload in (
        {"x": 0, "y": 0, "w": 400, "h": 400, "target": "avatar"},
        {"x": 0, "y": 0, "w": 640, "h": 200, "target": "banner"},
        {"x": 0, "y": 0, "w": 600, "h": 400, "target": "board_cover", "board_id": board["id"]},
    ):
        client.post(f"/api/items/{source['id']}/crop", json=payload)

    listed = client.get("/api/items").json()
    assert listed["total"] == 1
    assert [i["id"] for i in listed["items"]] == [source["id"]]


def test_a_second_source_gets_its_own_avatar_item(client):
    first_source = upload(client, image_kwargs={"seed": 1, "size": (900, 900)})["item"]
    second_source = upload(client, image_kwargs={"seed": 2, "size": (900, 900)})["item"]

    a = client.post(
        f"/api/items/{first_source['id']}/crop",
        json={"x": 0, "y": 0, "w": 400, "h": 400, "target": "avatar"},
    ).json()
    b = client.post(
        f"/api/items/{second_source['id']}/crop",
        json={"x": 0, "y": 0, "w": 400, "h": 400, "target": "avatar"},
    ).json()

    assert a["id"] != b["id"]
    assert client.get("/api/settings").json()["profile.avatar_item_id"] == b["id"]


def test_freeform_crops_still_use_content_addressed_storage(client, db):
    """Only the keyed destinations change; an ordinary crop is unaffected."""
    from app.models import Item

    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    derived = client.post(
        f"/api/items/{source['id']}/crop", json={"x": 0, "y": 0, "w": 300, "h": 200}
    ).json()

    stored = Path(db.get(Item, derived["id"]).storage_path)
    assert stored.stem == derived["hash"]


def test_purging_a_crop_leaves_the_original_alone(client, db):
    from app.models import Item

    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    derived = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 400, "h": 400, "target": "avatar"},
    ).json()
    source_path = db.get(Item, source["id"]).storage_path

    client.delete(f"/api/items/{derived['id']}")
    client.delete(f"/api/trash/{derived['id']}")

    assert (get_config().data_dir / source_path).exists()
    assert client.get(f"/api/items/{source['id']}/file/thumb").status_code == 200
