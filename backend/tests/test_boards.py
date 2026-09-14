from __future__ import annotations

from conftest import upload


def _tag_id(client, name: str) -> int:
    return client.post("/api/tags", json={"name": name}).json()["id"]


def test_manual_board_keeps_its_arrangement(client):
    ids = [upload(client, image_kwargs={"seed": i, "size": (300 + i, 200)})["item"]["id"] for i in range(3)]
    board = client.post("/api/boards", json={"name": "Studies & Palettes"}).json()
    assert board["slug"] == "studies-palettes"

    client.put(f"/api/boards/{board['id']}/items", json={"item_ids": list(reversed(ids))})
    listed = client.get("/api/items", params={"board": board["id"]}).json()

    assert [i["id"] for i in listed["items"]] == list(reversed(ids))
    assert client.get(f"/api/boards/{board['id']}").json()["item_count"] == 3


def test_board_tags_only_lists_tags_on_the_boards_items(client):
    on_board = upload(client, tags="landscape", image_kwargs={"seed": 1})["item"]["id"]
    off_board = upload(client, tags="portrait", image_kwargs={"seed": 2})["item"]["id"]
    _tag_id(client, "unused-elsewhere")  # exists globally, on no item at all

    board = client.post("/api/boards", json={"name": "Studies"}).json()
    client.put(f"/api/boards/{board['id']}/items", json={"item_ids": [on_board]})

    names = {t["name"] for t in client.get(f"/api/boards/{board['id']}/tags").json()}
    assert names == {"landscape"}
    assert "portrait" not in names
    assert off_board  # sanity: the other item exists but isn't on this board


def test_board_deletion_leaves_items_alone(client):
    item_id = upload(client)["item"]["id"]
    board = client.post("/api/boards", json={"name": "Temp"}).json()
    client.put(f"/api/boards/{board['id']}/items", json={"item_ids": [item_id]})

    assert client.delete(f"/api/boards/{board['id']}").status_code == 204
    assert client.get(f"/api/items/{item_id}").status_code == 200


def test_dynamic_board_membership_follows_tags(client):
    tag_id = _tag_id(client, "impressionism")
    board = client.post(
        "/api/boards",
        json={
            "name": "Impressionism",
            "is_dynamic": True,
            "query_tags": [{"tag_id": tag_id, "match_mode": "any"}],
        },
    ).json()
    assert board["item_count"] == 0

    item = upload(client, tags="impressionism")["item"]
    assert client.get(f"/api/boards/{board['id']}").json()["item_count"] == 1
    assert [i["id"] for i in client.get("/api/items", params={"board": board["id"]}).json()["items"]] == [item["id"]]

    # Untagging removes it again, with no reconciliation step.
    client.patch(f"/api/items/{item['id']}", json={"tags": []})
    assert client.get(f"/api/boards/{board['id']}").json()["item_count"] == 0


def test_dynamic_board_match_all_requires_every_tag(client):
    a, b = _tag_id(client, "forest"), _tag_id(client, "night")
    board = client.post(
        "/api/boards",
        json={
            "name": "Night forests",
            "is_dynamic": True,
            "query_tags": [
                {"tag_id": a, "match_mode": "all"},
                {"tag_id": b, "match_mode": "all"},
            ],
        },
    ).json()

    upload(client, tags="forest", image_kwargs={"seed": 1})
    both = upload(client, tags="forest, night", image_kwargs={"seed": 2})["item"]

    listed = client.get("/api/items", params={"board": board["id"]}).json()
    assert [i["id"] for i in listed["items"]] == [both["id"]]


def test_dynamic_board_rejects_manual_arrangement(client):
    tag_id = _tag_id(client, "x")
    board = client.post(
        "/api/boards",
        json={"name": "Dyn", "is_dynamic": True, "query_tags": [{"tag_id": tag_id}]},
    ).json()
    item_id = upload(client, tags="x")["item"]["id"]

    response = client.put(f"/api/boards/{board['id']}/items", json={"item_ids": [item_id]})
    assert response.status_code == 400

    bulk = client.post(
        "/api/items/bulk",
        json={"item_ids": [item_id], "action": "add_to_board", "board_id": board["id"]},
    )
    assert bulk.status_code == 400


def test_empty_dynamic_board_matches_nothing(client):
    """An unfinished saved search must not read as a copy of the whole collection."""
    upload(client)
    board = client.post("/api/boards", json={"name": "Empty", "is_dynamic": True}).json()
    assert board["item_count"] == 0
    assert client.get("/api/items", params={"board": board["id"]}).json()["total"] == 0


def test_dynamic_board_filters_can_be_changed_after_creation(client):
    """The board settings drawer's saved-search editor: PATCH replaces the
    query wholesale, so membership follows the new tags immediately."""
    forest, night = _tag_id(client, "forest"), _tag_id(client, "night")
    board = client.post(
        "/api/boards",
        json={"name": "Landscapes", "is_dynamic": True, "query_tags": [{"tag_id": forest, "match_mode": "any"}]},
    ).json()
    forest_item = upload(client, tags="forest", image_kwargs={"seed": 1})["item"]
    assert client.get(f"/api/boards/{board['id']}").json()["item_count"] == 1

    updated = client.patch(
        f"/api/boards/{board['id']}",
        json={"query_tags": [{"tag_id": night, "match_mode": "any"}]},
    ).json()
    assert [t["id"] for t in updated["query_tags"]] == [night]

    night_item = upload(client, tags="night", image_kwargs={"seed": 2})["item"]
    listed = client.get("/api/items", params={"board": board["id"]}).json()
    assert [i["id"] for i in listed["items"]] == [night_item["id"]]
    assert forest_item["id"] not in [i["id"] for i in listed["items"]]


def test_manual_board_rejects_query_tag_edits(client):
    board = client.post("/api/boards", json={"name": "Hand-picked"}).json()
    tag_id = _tag_id(client, "x")
    response = client.patch(
        f"/api/boards/{board['id']}", json={"query_tags": [{"tag_id": tag_id, "match_mode": "any"}]}
    )
    assert response.status_code == 400


def test_subboard_tag_filters_board_contents(client):
    board = client.post("/api/boards", json={"name": "Mixed"}).json()
    tagged = upload(client, tags="ink", image_kwargs={"seed": 1})["item"]
    plain = upload(client, image_kwargs={"seed": 2})["item"]
    client.put(f"/api/boards/{board['id']}/items", json={"item_ids": [tagged["id"], plain["id"]]})

    ink_id = client.get("/api/tags").json()[0]["id"]
    updated = client.put(
        f"/api/boards/{board['id']}/subboard-tags/{ink_id}", json={"is_active": True}
    ).json()
    assert [t["name"] for t in updated["subboard_tags"]] == ["ink"]

    filtered = client.get(
        "/api/items", params={"board": board["id"], "subboard_tag": ink_id}
    ).json()
    assert [i["id"] for i in filtered["items"]] == [tagged["id"]]


def test_board_position_and_ordering(client):
    first = client.post("/api/boards", json={"name": "One"}).json()
    second = client.post("/api/boards", json={"name": "Two"}).json()
    assert [b["id"] for b in client.get("/api/boards").json()] == [first["id"], second["id"]]

    client.patch(f"/api/boards/{second['id']}", json={"position": -1})
    assert [b["id"] for b in client.get("/api/boards").json()] == [second["id"], first["id"]]
