"""Cropping produces another version of the artwork, not a second card.

Regression cover for behaviour that was wrong in practice: crops used to be
ordinary items, so cropping a picture left a near-duplicate of it sitting in the
feed beside the original.
"""

from __future__ import annotations

from conftest import make_image, upload


def crop(client, item_id, **overrides):
    payload = {"x": 0, "y": 0, "w": 300, "h": 200}
    payload.update(overrides)
    response = client.post(f"/api/items/{item_id}/crop", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_a_crop_does_not_appear_in_the_feed(client):
    artwork = upload(client, image_kwargs={"size": (900, 900)})["item"]
    assert client.get("/api/items").json()["total"] == 1

    crop(client, artwork["id"])

    listed = client.get("/api/items").json()
    assert listed["total"] == 1, "the crop must not become a second card"
    assert [i["id"] for i in listed["items"]] == [artwork["id"]]


def test_a_crop_becomes_a_version_of_the_artwork(client):
    artwork = upload(client, image_kwargs={"size": (900, 900)})["item"]
    cropped = crop(client, artwork["id"])

    data = client.get(f"/api/items/{artwork['id']}/versions").json()
    assert data["artwork_id"] == artwork["id"]
    assert cropped["id"] in [v["id"] for v in data["versions"]]
    assert cropped["version_of_id"] == artwork["id"]


def test_the_crop_is_shown_by_default(client):
    """Cropping and seeing nothing change would read as the crop having failed."""
    artwork = upload(client, image_kwargs={"size": (900, 900)})["item"]
    cropped = crop(client, artwork["id"], w=400, h=300)

    shown = client.get(f"/api/items/{artwork['id']}").json()
    assert shown["id"] == artwork["id"], "the artwork keeps its own id"
    assert shown["displayed_item_id"] == cropped["id"]
    assert (shown["width"], shown["height"]) == (400, 300)


def test_the_original_stays_one_click_away(client):
    artwork = upload(client, image_kwargs={"size": (900, 900)})["item"]
    crop(client, artwork["id"])

    reverted = client.put(
        f"/api/items/{artwork['id']}/canonical", json={"version_id": artwork["id"]}
    ).json()
    assert reverted["canonical_id"] == artwork["id"]
    assert client.get(f"/api/items/{artwork['id']}").json()["width"] == 900


def test_opting_out_keeps_the_original_displayed(client):
    artwork = upload(client, image_kwargs={"size": (900, 900)})["item"]
    crop(client, artwork["id"], make_canonical=False)

    shown = client.get(f"/api/items/{artwork['id']}").json()
    assert shown["displayed_item_id"] == artwork["id"]
    assert len(client.get(f"/api/items/{artwork['id']}/versions").json()["versions"]) == 2


def test_cropping_keeps_tags_and_boards(client):
    artwork = upload(client, tags="landscape", title="Rooftops", image_kwargs={"size": (900, 900)})["item"]
    board = client.post("/api/boards", json={"name": "Keepers"}).json()
    client.put(f"/api/boards/{board['id']}/items", json={"item_ids": [artwork["id"]]})

    crop(client, artwork["id"])

    shown = client.get(f"/api/items/{artwork['id']}").json()
    assert shown["title"] == "Rooftops"
    assert [t["name"] for t in shown["tags"]] == ["landscape"]
    assert client.get(f"/api/boards/{board['id']}").json()["item_count"] == 1
    assert client.get("/api/items", params={"q": "tag:landscape"}).json()["total"] == 1


def test_cropping_a_crop_stays_flat(client):
    """Version sets have no depth, so a crop of a crop belongs to the artwork."""
    artwork = upload(client, image_kwargs={"size": (900, 900)})["item"]
    first = crop(client, artwork["id"], w=600, h=600)
    second = crop(client, first["id"], w=300, h=300)

    data = client.get(f"/api/items/{artwork['id']}/versions").json()
    assert len(data["versions"]) == 3
    assert second["version_of_id"] == artwork["id"]
    assert client.get("/api/items").json()["total"] == 1


def test_deleting_the_artwork_takes_its_crops(client):
    artwork = upload(client, image_kwargs={"size": (900, 900)})["item"]
    cropped = crop(client, artwork["id"])

    client.delete(f"/api/items/{artwork['id']}")
    assert client.get("/api/items").json()["total"] == 0
    # The crop went to the trash with it rather than being stranded.
    assert client.get(f"/api/items/{cropped['id']}").json()["is_deleted"] is True


def test_deleting_one_version_leaves_the_others_alone(client):
    """A version is a file of the artwork, not the artwork itself — trashing one
    must not cascade to its siblings the way trashing the artwork does."""
    artwork = upload(client, image_kwargs={"size": (900, 900)})["item"]
    first = crop(client, artwork["id"], w=600, h=600)
    second = crop(client, artwork["id"], w=300, h=300, make_canonical=False)

    response = client.delete(f"/api/items/{first['id']}")
    assert response.status_code == 200
    assert response.json()["is_deleted"] is True

    remaining = client.get(f"/api/items/{artwork['id']}/versions").json()
    remaining_ids = [v["id"] for v in remaining["versions"]]
    assert artwork["id"] in remaining_ids
    assert second["id"] in remaining_ids
    assert first["id"] not in remaining_ids
    assert client.get(f"/api/items/{artwork['id']}").json()["is_deleted"] is False
    assert client.get(f"/api/items/{second['id']}").json()["is_deleted"] is False


def test_cropping_a_jpeg_does_not_bloat_the_file(client):
    """Regression cover: crop_bytes used to always emit PNG, which — once
    process() ran it through the lossless PNG-to-WebP path — could make a crop
    several times *larger* than the JPEG it was cut from, despite covering less
    area. A JPEG source should stay roughly JPEG-sized after cropping."""
    source_bytes = make_image(size=(900, 900), fmt="JPEG")
    upload_response = client.post(
        "/api/items", files={"file": ("test.jpg", source_bytes, "image/jpeg")}
    )
    assert upload_response.status_code == 201, upload_response.text
    artwork = upload_response.json()["item"]
    assert artwork["mime_type"] == "image/jpeg"

    cropped = crop(client, artwork["id"], w=400, h=400)

    assert cropped["mime_type"] == "image/jpeg"
    # Cropping to a smaller region of a lossy source should not cost more bytes
    # than the source itself — the old behaviour could 3-4x it.
    assert cropped["filesize"] < artwork["filesize"] * 1.5
