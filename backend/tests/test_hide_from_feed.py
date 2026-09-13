"""Tag.hide_from_feed — opts a tag's items out of passive browsing only."""

from __future__ import annotations

from conftest import upload


def _tag_id(client, name: str) -> int:
    return next(t["id"] for t in client.get("/api/tags").json() if t["name"] == name)


def test_hidden_tag_is_excluded_from_the_default_listing(client):
    hidden = upload(client, tags="spoilers")["item"]
    visible = upload(client, tags="landscape", image_kwargs={"seed": 2})["item"]

    client.patch(f"/api/tags/{_tag_id(client, 'spoilers')}", json={"hide_from_feed": True})

    ids = [i["id"] for i in client.get("/api/items").json()["items"]]
    assert hidden["id"] not in ids
    assert visible["id"] in ids


def test_explicitly_searching_the_hidden_tag_still_finds_it(client):
    hidden = upload(client, tags="spoilers")["item"]
    client.patch(f"/api/tags/{_tag_id(client, 'spoilers')}", json={"hide_from_feed": True})

    result = client.get("/api/items", params={"q": "tag:spoilers"}).json()
    assert [i["id"] for i in result["items"]] == [hidden["id"]]


def test_a_board_still_shows_its_hidden_tag_items(client):
    hidden = upload(client, tags="spoilers")["item"]
    board = client.post("/api/boards", json={"name": "Keepsakes"}).json()
    client.put(f"/api/boards/{board['id']}/items", json={"item_ids": [hidden["id"]]})

    client.patch(f"/api/tags/{_tag_id(client, 'spoilers')}", json={"hide_from_feed": True})

    ids = [i["id"] for i in client.get("/api/items", params={"board": board["id"]}).json()["items"]]
    assert ids == [hidden["id"]]


def test_trash_still_shows_a_hidden_tag_item(client):
    hidden = upload(client, tags="spoilers")["item"]
    client.patch(f"/api/tags/{_tag_id(client, 'spoilers')}", json={"hide_from_feed": True})

    client.delete(f"/api/items/{hidden['id']}")

    ids = [i["id"] for i in client.get("/api/trash").json()["items"]]
    assert hidden["id"] in ids


def test_unhiding_the_tag_restores_it_to_the_feed(client):
    item = upload(client, tags="spoilers")["item"]
    tag_id = _tag_id(client, "spoilers")
    client.patch(f"/api/tags/{tag_id}", json={"hide_from_feed": True})
    assert item["id"] not in [i["id"] for i in client.get("/api/items").json()["items"]]

    client.patch(f"/api/tags/{tag_id}", json={"hide_from_feed": False})
    assert item["id"] in [i["id"] for i in client.get("/api/items").json()["items"]]
