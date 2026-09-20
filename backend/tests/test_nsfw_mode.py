"""Tag.nsfw + Settings "collection.nsfw_mode" — see services/queries.build_query."""

from __future__ import annotations

from conftest import upload


def _tag_id(client, name: str) -> int:
    return next(t["id"] for t in client.get("/api/tags").json() if t["name"] == name)


def _mark_nsfw(client, name: str) -> None:
    client.patch(f"/api/tags/{_tag_id(client, name)}", json={"nsfw": True})


def _set_nsfw_mode(client, on: bool) -> None:
    resp = client.put("/api/settings", json={"values": {"collection.nsfw_mode": on}})
    assert resp.status_code == 200, resp.text


def test_nsfw_tagged_item_is_excluded_from_the_default_listing(client):
    hidden = upload(client, tags="spoilers")["item"]
    visible = upload(client, tags="landscape", image_kwargs={"seed": 2})["item"]

    _mark_nsfw(client, "spoilers")

    ids = [i["id"] for i in client.get("/api/items").json()["items"]]
    assert hidden["id"] not in ids
    assert visible["id"] in ids


def test_explicitly_searching_the_nsfw_tag_still_finds_it(client):
    hidden = upload(client, tags="spoilers")["item"]
    _mark_nsfw(client, "spoilers")

    result = client.get("/api/items", params={"q": "tag:spoilers"}).json()
    assert [i["id"] for i in result["items"]] == [hidden["id"]]


def test_a_manual_board_also_hides_its_nsfw_tagged_item_by_default(client):
    """Unlike the old hide-from-feed behavior, NSFW filtering applies inside
    boards too — a board is no longer a way around the default hide."""
    hidden = upload(client, tags="spoilers")["item"]
    board = client.post("/api/boards", json={"name": "Keepsakes"}).json()
    client.put(f"/api/boards/{board['id']}/items", json={"item_ids": [hidden["id"]]})

    _mark_nsfw(client, "spoilers")

    ids = [i["id"] for i in client.get("/api/items", params={"board": board["id"]}).json()["items"]]
    assert ids == []
    assert client.get(f"/api/boards/{board['id']}").json()["item_count"] == 0


def test_trash_still_shows_an_nsfw_tagged_item(client):
    hidden = upload(client, tags="spoilers")["item"]
    _mark_nsfw(client, "spoilers")

    client.delete(f"/api/items/{hidden['id']}")

    ids = [i["id"] for i in client.get("/api/trash").json()["items"]]
    assert hidden["id"] in ids


def test_untagging_nsfw_restores_the_item_everywhere(client):
    item = upload(client, tags="spoilers")["item"]
    tag_id = _tag_id(client, "spoilers")
    client.patch(f"/api/tags/{tag_id}", json={"nsfw": True})
    assert item["id"] not in [i["id"] for i in client.get("/api/items").json()["items"]]

    client.patch(f"/api/tags/{tag_id}", json={"nsfw": False})
    assert item["id"] in [i["id"] for i in client.get("/api/items").json()["items"]]


def test_nsfw_mode_shows_only_nsfw_tagged_items(client):
    hidden = upload(client, tags="spoilers")["item"]
    visible = upload(client, tags="landscape", image_kwargs={"seed": 2})["item"]
    untagged = upload(client, image_kwargs={"seed": 3})["item"]
    _mark_nsfw(client, "spoilers")

    _set_nsfw_mode(client, True)
    try:
        ids = [i["id"] for i in client.get("/api/items").json()["items"]]
        assert ids == [hidden["id"]]
        assert visible["id"] not in ids
        assert untagged["id"] not in ids
    finally:
        _set_nsfw_mode(client, False)


def test_untagged_items_are_never_affected_by_the_default_hide(client):
    untagged = upload(client)["item"]
    upload(client, tags="spoilers", image_kwargs={"seed": 2})
    _mark_nsfw(client, "spoilers")

    ids = [i["id"] for i in client.get("/api/items").json()["items"]]
    assert untagged["id"] in ids


def test_dynamic_board_built_from_an_nsfw_tag_is_hidden_from_the_listing(client):
    upload(client, tags="spoilers")
    _mark_nsfw(client, "spoilers")
    tag_id = _tag_id(client, "spoilers")

    board = client.post(
        "/api/boards",
        json={
            "name": "Spoilers",
            "is_dynamic": True,
            "query_tags": [{"tag_id": tag_id, "match_mode": "any"}],
        },
    ).json()

    board_ids = [b["id"] for b in client.get("/api/boards").json()]
    assert board["id"] not in board_ids

    _set_nsfw_mode(client, True)
    try:
        board_ids = [b["id"] for b in client.get("/api/boards").json()]
        assert board["id"] in board_ids
    finally:
        _set_nsfw_mode(client, False)
