"""Naming versions, and role crops (avatar/banner/board cover) joining the
version set they belong to instead of existing as invisible side files."""

from __future__ import annotations

from conftest import upload


def test_variant_label_can_be_set_and_cleared(client):
    item = upload(client)["item"]
    assert item["variant_label"] is None

    named = client.patch(f"/api/items/{item['id']}", json={"variant_label": "Grayscale"}).json()
    assert named["variant_label"] == "Grayscale"

    cleared = client.patch(f"/api/items/{item['id']}", json={"variant_label": ""}).json()
    assert cleared["variant_label"] is None


def test_avatar_crop_joins_the_source_artworks_version_set(client):
    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    avatar = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 400, "h": 400, "target": "avatar"},
    ).json()

    versions = client.get(f"/api/items/{source['id']}/versions").json()
    assert avatar["id"] in [v["id"] for v in versions["versions"]]
    # A profile crop must never become what the artwork itself displays.
    assert versions["canonical_id"] == source["id"]


def test_banner_and_board_cover_crops_also_join_the_version_set(client):
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

    version_ids = {v["id"] for v in client.get(f"/api/items/{source['id']}/versions").json()["versions"]}
    assert {banner["id"], cover["id"]} <= version_ids


def test_recropping_the_avatar_keeps_it_attached_once(client):
    """Re-cropping reuses the same item id; attaching again must stay idempotent."""
    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 400, "h": 400, "target": "avatar"},
    )
    client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 100, "y": 100, "w": 300, "h": 300, "target": "avatar"},
    )
    versions = client.get(f"/api/items/{source['id']}/versions").json()["versions"]
    assert len(versions) == 2  # the source and exactly one avatar entry, not duplicated


def test_a_role_crop_can_be_given_its_own_variant_name(client):
    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    avatar = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 400, "h": 400, "target": "avatar"},
    ).json()

    named = client.patch(f"/api/items/{avatar['id']}", json={"variant_label": "Square, warm tone"}).json()
    assert named["variant_label"] == "Square, warm tone"
    assert named["derivative_target"] == "avatar"


def test_freeform_crop_is_unaffected_and_still_has_no_role(client):
    source = upload(client, image_kwargs={"size": (900, 900)})["item"]
    crop = client.post(
        f"/api/items/{source['id']}/crop", json={"x": 0, "y": 0, "w": 300, "h": 200}
    ).json()
    assert crop["derivative_target"] is None
    assert crop["variant_label"] is None
