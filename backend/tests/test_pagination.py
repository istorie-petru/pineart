"""Pagination must never repeat or drop an item, on any surface.

Regression cover for a real bug: on a dynamic board the cursor's ISO datetime
string was compared against SQLite's space-separated datetime column, so the
comparison matched nothing and every page returned the first page again — the
same few images repeating forever.
"""
from __future__ import annotations

import pytest
from conftest import upload


def walk(client, path, params, page_size=3, max_pages=30):
    seen, order, cursor, dupes = set(), [], None, []
    for _ in range(max_pages):
        query = dict(params, limit=page_size)
        if cursor:
            query["cursor"] = cursor
        page = client.get(path, params=query).json()
        for item in page["items"]:
            if item["id"] in seen:
                dupes.append(item["id"])
            seen.add(item["id"])
            order.append(item["id"])
        cursor = page["next_cursor"]
        if not cursor:
            return seen, dupes, order
    raise AssertionError("pagination did not terminate")


def test_feed_pages_without_repeats(client):
    for i in range(10):
        upload(client, image_kwargs={"seed": i, "size": (300 + i, 200)})
    seen, dupes, _ = walk(client, "/api/items", {})
    assert not dupes and len(seen) == 10


def test_dynamic_board_pages_without_repeats(client):
    for i in range(10):
        upload(client, tags="landscape", image_kwargs={"seed": i, "size": (300 + i, 200)})
    tag_id = client.get("/api/tags").json()[0]["id"]
    board = client.post(
        "/api/boards",
        json={"name": "Dyn", "is_dynamic": True, "query_tags": [{"tag_id": tag_id}]},
    ).json()
    seen, dupes, _ = walk(client, "/api/items", {"board": board["id"]})
    assert not dupes, f"repeated ids: {dupes}"
    assert len(seen) == 10


def test_manual_board_keeps_its_order_across_pages(client):
    ids = [upload(client, image_kwargs={"seed": i, "size": (300 + i, 200)})["item"]["id"] for i in range(10)]
    board = client.post("/api/boards", json={"name": "Manual"}).json()
    client.put(f"/api/boards/{board['id']}/items", json={"item_ids": list(reversed(ids))})
    _, dupes, order = walk(client, "/api/items", {"board": board["id"]})
    assert not dupes
    assert order == list(reversed(ids))


def test_trash_pages_without_repeats(client):
    ids = [upload(client, image_kwargs={"seed": i, "size": (300 + i, 200)})["item"]["id"] for i in range(8)]
    client.post("/api/items/bulk", json={"item_ids": ids, "action": "delete"})
    seen, dupes, _ = walk(client, "/api/trash", {})
    assert not dupes and len(seen) == 8


@pytest.mark.parametrize("sort", ["added_at", "dimensions", "filesize", "title"])
def test_every_sort_order_pages_without_repeats(client, sort):
    for i in range(9):
        item = upload(client, image_kwargs={"seed": i, "size": (300 + i * 7, 200 + i)})["item"]
        client.patch(f"/api/items/{item['id']}", json={"title": f"Study {i:02d}"})
    seen, dupes, _ = walk(client, "/api/items", {"sort": sort})
    assert not dupes, f"{sort} repeated: {dupes}"
    assert len(seen) == 9


def test_untagged_and_tag_listings_page_without_repeats(client):
    for i in range(7):
        upload(client, image_kwargs={"seed": i, "size": (300 + i, 200)})
    for i in range(7, 12):
        upload(client, tags="ink", image_kwargs={"seed": i, "size": (300 + i, 200)})

    seen, dupes, _ = walk(client, "/api/items/untagged", {})
    assert not dupes and len(seen) == 7

    tag_id = client.get("/api/tags").json()[0]["id"]
    seen, dupes, _ = walk(client, f"/api/tags/{tag_id}/items", {})
    assert not dupes and len(seen) == 5


def test_a_cursor_from_another_sort_is_rejected(client):
    """Silently accepting it would interleave two orderings and duplicate rows."""
    for i in range(6):
        upload(client, image_kwargs={"seed": i, "size": (300 + i, 200)})
    cursor = client.get("/api/items", params={"limit": 2, "sort": "added_at"}).json()["next_cursor"]
    response = client.get("/api/items", params={"limit": 2, "sort": "filesize", "cursor": cursor})
    assert response.status_code == 400
    assert "different ordering" in response.json()["detail"]


def test_a_malformed_cursor_is_rejected(client):
    upload(client)
    assert client.get("/api/items", params={"cursor": "not-a-cursor"}).status_code == 400
