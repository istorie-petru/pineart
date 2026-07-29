from __future__ import annotations

from conftest import make_image, upload


def test_upload_creates_item_with_derivatives(client):
    result = upload(client, title="First", tags="landscape, study")
    item = result["item"]

    assert result["created"] is True
    assert item["width"] == 600 and item["height"] == 400
    assert item["orientation"] == "landscape"
    assert item["mime_type"] == "image/webp"  # PNG converted at ingest by default
    assert {t["name"] for t in item["tags"]} == {"landscape", "study"}

    for kind in ("thumb", "display"):
        response = client.get(f"/api/items/{item['id']}/file/{kind}")
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/webp"

    download = client.get(f"/api/items/{item['id']}/download")
    assert download.status_code == 200


def test_exact_duplicate_is_not_reingested(client):
    data = make_image()
    first = upload(client, data=data)
    second = upload(client, data=data)

    assert second["created"] is False
    assert second["item"]["id"] == first["item"]["id"]
    assert client.get("/api/items").json()["total"] == 1


def test_near_duplicate_is_reported_but_still_saved(client):
    first = upload(client, image_kwargs={"seed": 1, "size": (600, 400)})
    # Same picture, re-encoded at a different size: a different SHA-256 but a
    # near-identical perceptual hash.
    second = upload(client, image_kwargs={"seed": 1, "size": (900, 600)})

    assert second["created"] is True
    assert second["near_duplicate_ids"] == [first["item"]["id"]]
    assert client.get("/api/items").json()["total"] == 2


def test_structurally_different_image_is_not_a_near_duplicate(client):
    upload(client, image_kwargs={"seed": 1, "size": (600, 400)})
    other = upload(client, image_kwargs={"seed": 5, "size": (600, 400)})

    assert other["near_duplicate_ids"] == []


def test_rejects_non_image_upload(client):
    response = client.post(
        "/api/items", files={"file": ("evil.png", b"not an image at all", "image/png")}
    )
    assert response.status_code == 400


def test_orientation_and_dominant_color(client):
    portrait = upload(client, image_kwargs={"size": (400, 900), "color": (12, 200, 90)})["item"]
    square = upload(client, image_kwargs={"size": (500, 500), "color": (200, 12, 90)})["item"]

    assert portrait["orientation"] == "portrait"
    assert square["orientation"] == "square"
    assert portrait["dominant_color"].startswith("#")


def test_patch_replaces_tags(client):
    item = upload(client, tags="a, b")["item"]
    patched = client.patch(
        f"/api/items/{item['id']}", json={"title": "Renamed", "tags": ["c"]}
    ).json()

    assert patched["title"] == "Renamed"
    assert [t["name"] for t in patched["tags"]] == ["c"]


def test_pagination_walks_the_whole_collection(client):
    created = {upload(client, image_kwargs={"size": (300 + i, 200)})["item"]["id"] for i in range(7)}

    seen: set[int] = set()
    cursor = None
    pages = 0
    while True:
        params = {"limit": 3}
        if cursor:
            params["cursor"] = cursor
        page = client.get("/api/items", params=params).json()
        seen.update(i["id"] for i in page["items"])
        cursor = page["next_cursor"]
        pages += 1
        if not cursor:
            break
        assert pages < 10, "pagination did not terminate"

    assert seen == created


def test_sort_by_filesize_and_title(client):
    upload(client, title="Zebra", image_kwargs={"size": (200, 200)})
    upload(client, title="Alpha", image_kwargs={"size": (1200, 900)})

    by_title = client.get("/api/items", params={"sort": "title"}).json()["items"]
    assert [i["title"] for i in by_title] == ["Alpha", "Zebra"]

    by_size = client.get("/api/items", params={"sort": "filesize"}).json()["items"]
    sizes = [i["filesize"] for i in by_size]
    assert sizes == sorted(sizes, reverse=True)


def test_untagged_inbox(client):
    tagged = upload(client, tags="x", image_kwargs={"size": (300, 300)})["item"]
    untagged_item = upload(client, image_kwargs={"size": (301, 300)})["item"]

    ids = [i["id"] for i in client.get("/api/items/untagged").json()["items"]]
    assert untagged_item["id"] in ids
    assert tagged["id"] not in ids


def test_random_pages_through_the_whole_set(client):
    """A seeded shuffle, not a one-shot `ORDER BY RANDOM()` — the point being
    fixed here is that "load more" on a random sort used to be structurally
    impossible (`next_cursor` was always `None`), so the second page just
    reshuffled the entire set from scratch instead of continuing the first
    page's shuffle. With a seed riding in the cursor, paging through a random
    sort has to behave exactly like any other sort: no duplicates, no gaps,
    and a `None` cursor only once everything has actually been seen."""
    uploaded_ids = {
        upload(client, image_kwargs={"size": (300 + i, 200)})["item"]["id"] for i in range(4)
    }

    first = client.get("/api/items", params={"random": True, "limit": 2}).json()
    assert len(first["items"]) == 2
    assert first["next_cursor"] is not None
    assert first["total"] == 4

    second = client.get(
        "/api/items", params={"random": True, "limit": 2, "cursor": first["next_cursor"]}
    ).json()
    assert len(second["items"]) == 2
    assert second["next_cursor"] is None

    seen_ids = {i["id"] for i in first["items"]} | {i["id"] for i in second["items"]}
    assert seen_ids == uploaded_ids


def test_random_order_is_not_insertion_order(client):
    """Regression test: the rank formula behind "random" sort used to use a
    multiplier far too small relative to its modulus, so for any realistic
    collection size `rank(id)` was strictly increasing in `id` no matter what
    seed was picked — sorting by it was silently identical to sorting by
    upload order (and, since batch-tagged items tend to share consecutive
    ids, looked like it was grouped by tag). A dozen sequential ids sorted
    "randomly" should come back neither ascending nor descending."""
    ids = [upload(client, image_kwargs={"size": (300 + i, 200)})["item"]["id"] for i in range(12)]

    page = client.get("/api/items", params={"random": True, "limit": 12}).json()
    returned_ids = [i["id"] for i in page["items"]]

    assert sorted(returned_ids) == sorted(ids)
    assert returned_ids != sorted(ids)
    assert returned_ids != sorted(ids, reverse=True)


def test_bulk_tag_and_delete(client):
    ids = [upload(client, image_kwargs={"size": (300 + i, 200)})["item"]["id"] for i in range(3)]

    tagged = client.post(
        "/api/items/bulk", json={"item_ids": ids, "action": "tag", "tags": ["bulk"]}
    )
    assert tagged.json()["affected"] == 3
    assert client.get("/api/items", params={"q": "tag:bulk"}).json()["total"] == 3

    client.post("/api/items/bulk", json={"item_ids": ids[:2], "action": "delete"})
    assert client.get("/api/items").json()["total"] == 1
    assert client.get("/api/trash").json()["total"] == 2


def test_bulk_import_reports_failures_without_aborting(client):
    files = [
        ("files", ("ok1.png", make_image(size=(300, 200)), "image/png")),
        ("files", ("bad.png", b"garbage", "image/png")),
        ("files", ("ok2.png", make_image(size=(301, 200)), "image/png")),
    ]
    result = client.post("/api/items/bulk-import", files=files).json()

    assert len(result["created"]) == 2
    assert len(result["failed"]) == 1
    assert result["failed"][0]["filename"] == "bad.png"


def test_recommendations_prefer_shared_tags(client):
    subject = upload(client, tags="forest, green", image_kwargs={"size": (300, 300)})["item"]
    close = upload(client, tags="forest, green", image_kwargs={"size": (310, 300)})["item"]
    upload(client, tags="portrait", image_kwargs={"size": (320, 300)})

    recommended = client.get(f"/api/items/{subject['id']}/recommendations").json()
    assert recommended[0]["id"] == close["id"]
    assert subject["id"] not in [r["id"] for r in recommended]
