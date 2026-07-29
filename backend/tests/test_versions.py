"""Artwork versions: several files, one artwork, one of them displayed."""

from __future__ import annotations

from conftest import make_image, upload


def add_version(client, artwork_id, seed=99, size=(800, 600), make_canonical=False):
    return client.post(
        f"/api/items/{artwork_id}/versions",
        files={"file": ("v.png", make_image(seed=seed, size=size), "image/png")},
        data={"make_canonical": str(make_canonical).lower()},
    )


def test_a_version_does_not_appear_as_its_own_card(client):
    """A set of scans of one picture should read as one artwork in the grid."""
    artwork = upload(client, image_kwargs={"seed": 1})["item"]
    assert client.get("/api/items").json()["total"] == 1

    response = add_version(client, artwork["id"], seed=2)
    assert response.status_code == 201
    assert len(response.json()["versions"]) == 2
    assert client.get("/api/items").json()["total"] == 1


def test_listing_versions(client):
    artwork = upload(client, image_kwargs={"seed": 1})["item"]
    add_version(client, artwork["id"], seed=2)

    data = client.get(f"/api/items/{artwork['id']}/versions").json()
    assert data["artwork_id"] == artwork["id"]
    assert data["canonical_id"] == artwork["id"]  # its own file, by default
    assert [v["id"] for v in data["versions"]][0] == artwork["id"]


def test_choosing_which_version_is_displayed(client):
    artwork = upload(client, image_kwargs={"seed": 1, "size": (400, 400)})["item"]
    added = add_version(client, artwork["id"], seed=2, size=(1600, 1200)).json()
    version_id = [v["id"] for v in added["versions"] if v["id"] != artwork["id"]][0]

    updated = client.put(
        f"/api/items/{artwork['id']}/canonical", json={"version_id": version_id}
    ).json()
    assert updated["canonical_id"] == version_id

    # The artwork keeps its own id, but now shows the other file's pixels.
    shown = client.get(f"/api/items/{artwork['id']}").json()
    assert shown["id"] == artwork["id"]
    assert shown["displayed_item_id"] == version_id
    assert (shown["width"], shown["height"]) == (1600, 1200)
    assert f"/api/items/{version_id}/file/thumb" == shown["urls"]["thumb"]


def test_the_grid_shows_the_canonical_file(client):
    artwork = upload(client, image_kwargs={"seed": 1, "size": (400, 400)})["item"]
    added = add_version(client, artwork["id"], seed=2, size=(1600, 1200), make_canonical=True).json()
    version_id = [v["id"] for v in added["versions"] if v["id"] != artwork["id"]][0]

    listed = client.get("/api/items").json()["items"]
    assert len(listed) == 1
    assert listed[0]["id"] == artwork["id"]
    assert listed[0]["displayed_item_id"] == version_id


def test_switching_the_canonical_file_keeps_tags_and_boards(client):
    """The point of the split: changing the shown file must not move the artwork."""
    artwork = upload(client, tags="landscape", title="Rooftops", image_kwargs={"seed": 1})["item"]
    board = client.post("/api/boards", json={"name": "Keepers"}).json()
    client.put(f"/api/boards/{board['id']}/items", json={"item_ids": [artwork["id"]]})

    added = add_version(client, artwork["id"], seed=2).json()
    version_id = [v["id"] for v in added["versions"] if v["id"] != artwork["id"]][0]
    client.put(f"/api/items/{artwork['id']}/canonical", json={"version_id": version_id})

    shown = client.get(f"/api/items/{artwork['id']}").json()
    assert shown["title"] == "Rooftops"
    assert [t["name"] for t in shown["tags"]] == ["landscape"]
    assert client.get(f"/api/boards/{board['id']}").json()["item_count"] == 1
    assert client.get("/api/items", params={"q": "tag:landscape"}).json()["total"] == 1


def test_reverting_to_the_artworks_own_file(client):
    artwork = upload(client, image_kwargs={"seed": 1})["item"]
    added = add_version(client, artwork["id"], seed=2, make_canonical=True).json()
    assert added["canonical_id"] != artwork["id"]

    reverted = client.put(
        f"/api/items/{artwork['id']}/canonical", json={"version_id": artwork["id"]}
    ).json()
    assert reverted["canonical_id"] == artwork["id"]


def test_attaching_an_existing_item_as_a_version(client):
    first = upload(client, image_kwargs={"seed": 1})["item"]
    second = upload(client, image_kwargs={"seed": 2})["item"]
    assert client.get("/api/items").json()["total"] == 2

    client.post(f"/api/items/{first['id']}/versions/attach", json={"item_id": second["id"]})
    assert client.get("/api/items").json()["total"] == 1


def test_detaching_promotes_a_version_back_to_an_artwork(client):
    artwork = upload(client, image_kwargs={"seed": 1})["item"]
    added = add_version(client, artwork["id"], seed=2, make_canonical=True).json()
    version_id = [v["id"] for v in added["versions"] if v["id"] != artwork["id"]][0]

    client.post(f"/api/items/{version_id}/versions/detach")
    assert client.get("/api/items").json()["total"] == 2
    # The artwork must stop displaying a file that is no longer part of it.
    assert client.get(f"/api/items/{artwork['id']}").json()["displayed_item_id"] == artwork["id"]


def test_versions_cannot_nest(client):
    artwork = upload(client, image_kwargs={"seed": 1})["item"]
    other = upload(client, image_kwargs={"seed": 2})["item"]
    added = add_version(client, artwork["id"], seed=3).json()
    version_id = [v["id"] for v in added["versions"] if v["id"] != artwork["id"]][0]

    # Attaching to a version attaches to its artwork instead of building a tree.
    client.post(f"/api/items/{version_id}/versions/attach", json={"item_id": other["id"]})
    data = client.get(f"/api/items/{artwork['id']}/versions").json()
    assert len(data["versions"]) == 3


def test_an_item_with_versions_cannot_be_folded_into_another(client):
    """Doing so silently would discard that item's own canonical choice."""
    a = upload(client, image_kwargs={"seed": 1})["item"]
    b = upload(client, image_kwargs={"seed": 2})["item"]
    add_version(client, b["id"], seed=3)

    response = client.post(f"/api/items/{a['id']}/versions/attach", json={"item_id": b["id"]})
    assert response.status_code == 400
    assert "versions of its own" in response.json()["detail"]


def test_an_unrelated_item_cannot_be_made_canonical(client):
    a = upload(client, image_kwargs={"seed": 1})["item"]
    b = upload(client, image_kwargs={"seed": 2})["item"]
    response = client.put(f"/api/items/{a['id']}/canonical", json={"version_id": b["id"]})
    assert response.status_code == 400


def test_a_trashed_canonical_version_falls_back_to_the_original(client):
    """A stale pointer must degrade to the original, not to a broken image."""
    artwork = upload(client, image_kwargs={"seed": 1})["item"]
    added = add_version(client, artwork["id"], seed=2, make_canonical=True).json()
    version_id = [v["id"] for v in added["versions"] if v["id"] != artwork["id"]][0]

    client.delete(f"/api/items/{version_id}")
    shown = client.get(f"/api/items/{artwork['id']}").json()
    assert shown["displayed_item_id"] == artwork["id"]
    assert shown["urls"]["thumb"] == f"/api/items/{artwork['id']}/file/thumb"


def test_deleting_the_artwork_takes_its_versions(client):
    artwork = upload(client, image_kwargs={"seed": 1})["item"]
    added = add_version(client, artwork["id"], seed=2).json()
    version_id = [v["id"] for v in added["versions"] if v["id"] != artwork["id"]][0]

    client.delete(f"/api/items/{artwork['id']}")
    client.post("/api/trash/purge", params={"force": True})
    assert client.get(f"/api/items/{version_id}").status_code == 404


def test_uploading_the_same_file_as_a_version_is_refused(client):
    data = make_image(seed=1)
    artwork = upload(client, data=data)["item"]
    response = client.post(
        f"/api/items/{artwork['id']}/versions",
        files={"file": ("same.png", data, "image/png")},
    )
    assert response.status_code == 400
