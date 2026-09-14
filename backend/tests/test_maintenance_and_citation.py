"""Tests for the maintenance endpoints (integrity/reconcile/near-duplicates),
tag merge/unused, citation export, and the disk-full upload failure mode —
all added per advance.md."""

from __future__ import annotations

import errno

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Item
from conftest import make_image, upload


def test_integrity_check_passes_on_freshly_uploaded_item(client: TestClient) -> None:
    upload(client)
    report = client.get("/api/maintenance/integrity").json()
    assert report["issues"] == []
    assert report["checked"] >= 1


def test_reconcile_reports_no_drift_for_a_freshly_uploaded_item(client: TestClient) -> None:
    # Note: the shared test data directory persists image files across the
    # whole session (only DB rows are wiped between tests, see conftest's
    # `clean_tables`), so files left behind by earlier tests can legitimately
    # show up as "orphaned" here. That's the fixture, not a reconcile bug —
    # this test only asserts about the file this test itself created.
    item = upload(client)
    report = client.post("/api/maintenance/reconcile").json()
    assert report["missing_files"] == []
    file_resp = client.get(f"/api/items/{item['item']['id']}/download")
    assert file_resp.status_code == 200


def test_near_duplicates_finds_resized_copy(client: TestClient) -> None:
    a = upload(client, image_kwargs={"seed": 1, "size": (600, 400)})
    b = upload(client, image_kwargs={"seed": 1, "size": (300, 200)})
    pairs = client.get("/api/maintenance/near-duplicates").json()
    ids = {p["a"]["id"] for p in pairs} | {p["b"]["id"] for p in pairs}
    assert a["item"]["id"] in ids
    assert b["item"]["id"] in ids


def test_near_duplicates_skips_unparseable_phash_instead_of_500ing(client: TestClient) -> None:
    """A malformed `phash` row (bad hex, from a bug or manual DB edit) used to
    blow up the whole scan with an unhandled `ValueError` mid comparison-loop
    — one bad row meant a 500 for the entire "check & merge duplicates"
    review, no matter how many legitimate matches there were to see. The
    fix mirrors what `find_near_duplicates` (the ingest-time sibling of this
    scan) already did: parse each phash once up front and skip rows that
    don't parse, rather than let them fail mid-loop."""
    a = upload(client, image_kwargs={"seed": 1, "size": (600, 400)})
    b = upload(client, image_kwargs={"seed": 1, "size": (300, 200)})

    with SessionLocal() as db:
        broken = db.get(Item, a["item"]["id"])
        broken.phash = "not-valid-hex"
        db.commit()

    response = client.get("/api/maintenance/near-duplicates")
    assert response.status_code == 200
    pairs = response.json()
    ids = {p["a"]["id"] for p in pairs} | {p["b"]["id"] for p in pairs}
    # The broken row is skipped entirely rather than crashing the scan, so
    # it can't show up in a pair — but the other, valid item is unaffected.
    assert a["item"]["id"] not in ids
    assert b["item"]["id"] not in ids or not pairs


def test_tag_merge_reassigns_and_dedupes(client: TestClient) -> None:
    item1 = upload(client, image_kwargs={"seed": 1})
    item2 = upload(client, image_kwargs={"seed": 2})

    client.patch(f"/api/items/{item1['item']['id']}", json={"tags": ["landscapes"]})
    client.patch(f"/api/items/{item2['item']['id']}", json={"tags": ["landscape", "landscapes"]})

    tags = {t["name"]: t["id"] for t in client.get("/api/tags").json()}
    source_id, target_id = tags["landscapes"], tags["landscape"]

    result = client.post(f"/api/tags/{source_id}/merge", json={"into_tag_id": target_id})
    assert result.status_code == 200
    body = result.json()
    # item1 only had "landscape" -> reassigned; item2 had both -> deduped, not reassigned.
    assert body["items_reassigned"] == 1

    assert client.get(f"/api/tags/{source_id}").status_code == 404
    remaining = client.get("/api/tags").json()
    assert "landscapes" not in {t["name"] for t in remaining}


def test_unused_tags_lists_only_zero_item_tags(client: TestClient) -> None:
    item = upload(client)
    client.patch(f"/api/items/{item['item']['id']}", json={"tags": ["used"]})
    client.post("/api/tags", json={"name": "unused-one"})

    names = {t["name"] for t in client.get("/api/tags/unused").json()}
    assert "unused-one" in names
    assert "used" not in names


def test_citation_export_for_item_and_board(client: TestClient) -> None:
    item = upload(client, title="Sunset Study", source_url="https://example.com/art")
    item_id = item["item"]["id"]

    export = client.get(f"/api/items/{item_id}/citation").json()
    assert export["entries"][0]["title"] == "Sunset Study"
    assert export["entries"][0]["source"] == "https://example.com/art"
    assert "Sunset Study" in export["text"]

    board = client.post("/api/boards", json={"name": "Studies"}).json()
    client.put(f"/api/boards/{board['id']}/items", json={"item_ids": [item_id]})
    board_export = client.get(f"/api/boards/{board['id']}/citation").json()
    assert len(board_export["entries"]) == 1
    assert board_export["entries"][0]["item_id"] == item_id


def test_disk_full_mid_upload_is_a_clean_400(client: TestClient, monkeypatch) -> None:
    """A disk-full write failure must surface as a clear rejection, not a raw
    500 with a traceback (advance.md §8)."""
    from app.services import images

    def _out_of_space(*args, **kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(images, "_atomic_write_bytes", _out_of_space)
    monkeypatch.setattr(images, "_atomic_save_image", _out_of_space)

    # A never-before-seen seed: process() skips writing entirely for content
    # it already has a file for (the whole point of content-addressed
    # storage), which would let this test pass for the wrong reason if it
    # reused an image another test already uploaded.
    response = client.post(
        "/api/items",
        files={"file": ("test.png", make_image(seed=999999), "image/png")},
    )
    assert response.status_code == 400
    assert "disk space" in response.json()["detail"].lower()
