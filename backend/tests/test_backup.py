from __future__ import annotations

import io
import json
import zipfile

from conftest import upload

from app.services import search


def _build_collection(client) -> dict:
    item = upload(client, title="Rooftops", tags="cityscape, ink", image_kwargs={"seed": 1})["item"]
    other = upload(client, title="Harbour", tags="ink", image_kwargs={"seed": 2})["item"]

    board = client.post("/api/boards", json={"name": "Cities", "description": "urban"}).json()
    client.put(f"/api/boards/{board['id']}/items", json={"item_ids": [other["id"], item["id"]]})

    client.post("/api/links", json={"title": "ArtStation", "url": "https://artstation.com"})
    client.put("/api/settings", json={"values": {"appearance.accent_color": "#123456"}})
    return {"item": item, "other": other, "board": board}


def test_export_archive_contains_manifest_and_originals(client):
    _build_collection(client)
    response = client.get("/api/export")
    assert response.status_code == 200

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        image_members = [n for n in archive.namelist() if n.startswith("images/")]

    assert manifest["version"] == 1
    assert len(manifest["items"]) == 2
    assert len(image_members) == 2
    assert {t["name"] for t in manifest["tags"]} == {"cityscape", "ink"}
    assert manifest["settings"]["appearance.accent_color"] == "#123456"
    # Derivatives are regenerated on import, so they must not be in the archive.
    assert not any("_thumb" in n or "_display" in n for n in image_members)


def test_import_restores_a_wiped_collection(client, db):
    built = _build_collection(client)
    archive_bytes = client.get("/api/export").content

    for item in client.get("/api/items").json()["items"]:
        client.delete(f"/api/items/{item['id']}")
    client.post("/api/trash/purge", params={"force": True})
    client.delete(f"/api/boards/{built['board']['id']}")
    assert client.get("/api/items").json()["total"] == 0

    result = client.post(
        "/api/import", files={"file": ("backup.zip", archive_bytes, "application/zip")}
    ).json()
    assert result["items_imported"] == 2

    restored = client.get("/api/items").json()
    assert restored["total"] == 2
    titles = {i["title"] for i in restored["items"]}
    assert titles == {"Rooftops", "Harbour"}

    boards = client.get("/api/boards").json()
    assert len(boards) == 1 and boards[0]["item_count"] == 2

    # Search must work on restored items, i.e. the FTS index was rebuilt too.
    assert client.get("/api/search", params={"q": "harbour"}).json()["total"] == 1


def test_import_is_idempotent(client):
    _build_collection(client)
    archive_bytes = client.get("/api/export").content

    second = client.post(
        "/api/import", files={"file": ("backup.zip", archive_bytes, "application/zip")}
    ).json()

    assert second["items_imported"] == 0
    assert second["skipped"] == 2
    assert client.get("/api/items").json()["total"] == 2
    assert len(client.get("/api/boards").json()) == 1


def test_export_import_export_is_hash_stable(client):
    """Content identity must survive a round trip.

    The archive stores the normalized file (a PNG converted to lossless WebP at
    ingest), so an importer that re-hashed those bytes would assign new
    identities and turn every backup restore into a duplication event.
    """
    _build_collection(client)
    first = json.loads(zipfile.ZipFile(io.BytesIO(client.get("/api/export").content)).read("manifest.json"))

    client.post("/api/import", files={"file": ("b.zip", client.get("/api/export").content, "application/zip")})
    second = json.loads(zipfile.ZipFile(io.BytesIO(client.get("/api/export").content)).read("manifest.json"))

    assert {i["hash"] for i in first["items"]} == {i["hash"] for i in second["items"]}
    assert len(second["items"]) == 2


def test_import_rejects_a_non_archive(client):
    response = client.post(
        "/api/import", files={"file": ("nope.zip", b"not a zip", "application/zip")}
    )
    assert response.status_code == 400


def test_reindex_cli_rebuilds_the_search_index(client, db):
    item = upload(client, title="Findable")["item"]
    db.execute(search.text("DELETE FROM items_fts"))
    db.commit()
    assert client.get("/api/search", params={"q": "findable"}).json()["total"] == 0

    from app.cli import cmd_reindex

    cmd_reindex()
    assert [i["id"] for i in client.get("/api/search", params={"q": "findable"}).json()["items"]] == [
        item["id"]
    ]
