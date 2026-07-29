"""Tags and a board can be applied in the same request that uploads the images."""

from __future__ import annotations

from conftest import make_image


def _files(count, start=0):
    return [
        ("files", (f"{i}.png", make_image(seed=i + start, size=(300 + i, 200)), "image/png"))
        for i in range(count)
    ]


def test_upload_with_tags(client):
    result = client.post(
        "/api/items/bulk-import", files=_files(3), data={"tags": "landscape, plein-air"}
    ).json()

    assert len(result["created"]) == 3
    for item in result["created"]:
        # The response reflects the tags, not a snapshot from before they applied.
        assert {tag["name"] for tag in item["tags"]} == {"landscape", "plein-air"}

    assert client.get("/api/items", params={"q": "tag:landscape"}).json()["total"] == 3


def test_upload_straight_into_a_board(client):
    board = client.post("/api/boards", json={"name": "Imports"}).json()
    client.post("/api/items/bulk-import", files=_files(3), data={"board_id": str(board["id"])})

    assert client.get(f"/api/boards/{board['id']}").json()["item_count"] == 3
    listed = client.get("/api/items", params={"board": board["id"]}).json()
    assert listed["total"] == 3


def test_upload_with_both_tags_and_board(client):
    board = client.post("/api/boards", json={"name": "Studies"}).json()
    client.post(
        "/api/items/bulk-import",
        files=_files(2),
        data={"tags": "study", "board_id": str(board["id"])},
    )

    assert client.get(f"/api/boards/{board['id']}").json()["item_count"] == 2
    assert client.get("/api/items", params={"q": "tag:study"}).json()["total"] == 2


def test_tags_apply_to_duplicates_too(client):
    """Re-adding a picture you already have, with tags, means "tag this one"."""
    first = client.post("/api/items/bulk-import", files=_files(1)).json()
    assert first["created"][0]["tags"] == []

    again = client.post("/api/items/bulk-import", files=_files(1), data={"tags": "ink"}).json()
    assert not again["created"] and len(again["duplicates"]) == 1
    assert [t["name"] for t in again["duplicates"][0]["tags"]] == ["ink"]


def test_new_tags_are_searchable_immediately(client):
    """The FTS index has to be updated by the same request."""
    client.post("/api/items/bulk-import", files=_files(1), data={"tags": "Shōyō Hinata"})
    found = client.get("/api/search", params={"q": "shoyo"}).json()
    assert found["total"] == 1


def test_a_dynamic_board_is_refused(client):
    tag_id = client.post("/api/tags", json={"name": "auto"}).json()["id"]
    board = client.post(
        "/api/boards",
        json={"name": "Auto", "is_dynamic": True, "query_tags": [{"tag_id": tag_id}]},
    ).json()

    response = client.post(
        "/api/items/bulk-import", files=_files(1), data={"board_id": str(board["id"])}
    )
    assert response.status_code == 400
    assert "Dynamic boards" in response.json()["detail"]


def test_an_unknown_board_is_refused_before_anything_is_stored(client):
    response = client.post("/api/items/bulk-import", files=_files(2), data={"board_id": "9999"})
    assert response.status_code == 404
    assert client.get("/api/items").json()["total"] == 0


def test_upload_without_metadata_still_works(client):
    result = client.post("/api/items/bulk-import", files=_files(2)).json()
    assert len(result["created"]) == 2
    assert all(item["tags"] == [] for item in result["created"])
