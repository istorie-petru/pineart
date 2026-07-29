"""Tag supercategories: grouping, colour inheritance, and cleanup on delete."""

from __future__ import annotations

from conftest import upload


def test_create_and_list_categories(client):
    created = client.post("/api/tags/categories", json={"name": "Characters", "color": "#e63946"})
    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "Characters"
    assert body["slug"] == "characters"
    assert body["color"] == "#e63946"

    listed = client.get("/api/tags/categories").json()
    assert [c["name"] for c in listed] == ["Characters"]


def test_category_name_is_case_insensitive_on_create(client):
    a = client.post("/api/tags/categories", json={"name": "Shows", "color": "#457b9d"}).json()
    b = client.post("/api/tags/categories", json={"name": "shows", "color": "#000000"}).json()
    assert a["id"] == b["id"]


def test_tag_can_be_created_with_a_category(client):
    category = client.post("/api/tags/categories", json={"name": "Media", "color": "#2a9d8f"}).json()
    tag = client.post("/api/tags", json={"name": "oil-painting", "category_id": category["id"]}).json()
    assert tag["category"]["id"] == category["id"]
    assert tag["category"]["name"] == "Media"


def test_creating_a_tag_with_an_unknown_category_is_rejected(client):
    response = client.post("/api/tags", json={"name": "orphan", "category_id": 999})
    assert response.status_code == 404


def test_tag_color_falls_back_to_category_color_only_in_the_absence_of_its_own(client):
    """The API reports the tag's own colour as-is; the frontend does the
    fallback-to-category display logic. This just pins that both pieces of
    data travel together on the wire."""
    category = client.post("/api/tags/categories", json={"name": "Characters", "color": "#e63946"}).json()
    tag = client.post("/api/tags", json={"name": "hinata"}).json()
    patched = client.patch(f"/api/tags/{tag['id']}", json={"category_id": category["id"]}).json()
    assert patched["color"] is None
    assert patched["category"]["color"] == "#e63946"

    recoloured = client.patch(f"/api/tags/{tag['id']}", json={"color": "#123456"}).json()
    assert recoloured["color"] == "#123456"
    assert recoloured["category"]["color"] == "#e63946"


def test_patching_a_tag_to_an_unknown_category_is_rejected(client):
    tag = client.post("/api/tags", json={"name": "solo"}).json()
    response = client.patch(f"/api/tags/{tag['id']}", json={"category_id": 999})
    assert response.status_code == 404


def test_clear_category_removes_the_assignment(client):
    category = client.post("/api/tags/categories", json={"name": "Shows", "color": "#457b9d"}).json()
    tag = client.post("/api/tags", json={"name": "haikyuu", "category_id": category["id"]}).json()
    cleared = client.patch(f"/api/tags/{tag['id']}", json={"clear_category": True}).json()
    assert cleared["category"] is None


def test_deleting_a_category_uncategorizes_its_tags_without_deleting_them(client):
    category = client.post("/api/tags/categories", json={"name": "Temp", "color": "#000000"}).json()
    tag = client.post("/api/tags", json={"name": "kept", "category_id": category["id"]}).json()

    assert client.delete(f"/api/tags/categories/{category['id']}").status_code == 204

    still_there = client.get(f"/api/tags/{tag['id']}").json()
    assert still_there["name"] == "kept"
    assert still_there["category"] is None
    assert client.get("/api/tags/categories").json() == []


def test_category_rename_rejects_a_name_already_in_use(client):
    client.post("/api/tags/categories", json={"name": "one", "color": "#000000"})
    second = client.post("/api/tags/categories", json={"name": "two", "color": "#000000"}).json()
    assert client.patch(f"/api/tags/categories/{second['id']}", json={"name": "ONE"}).status_code == 409


def test_suggest_includes_category(client):
    category = client.post("/api/tags/categories", json={"name": "Characters", "color": "#e63946"}).json()
    client.post("/api/tags", json={"name": "hinata", "category_id": category["id"]})
    upload(client, tags="hinata")

    results = client.get("/api/tags/suggest", params={"q": "hinata"}).json()
    assert results[0]["category"]["id"] == category["id"]


def test_graph_nodes_include_category(client):
    category = client.post("/api/tags/categories", json={"name": "Characters", "color": "#e63946"}).json()
    client.post("/api/tags", json={"name": "hinata", "category_id": category["id"]})
    upload(client, tags="hinata")

    nodes = client.get("/api/tags/graph").json()["nodes"]
    node = next(n for n in nodes if n["name"] == "hinata")
    assert node["category"]["id"] == category["id"]


def test_categories_endpoint_is_not_shadowed_by_the_tag_id_route(client):
    """A request to /api/tags/categories must not be swallowed by /{tag_id}."""
    response = client.get("/api/tags/categories")
    assert response.status_code == 200
    assert response.json() == []
