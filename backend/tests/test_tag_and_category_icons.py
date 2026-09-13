"""Tag.icon / TagCategory.icon — a tag's own icon, or its category's as default."""

from __future__ import annotations

from conftest import upload


def test_category_icon_round_trips(client):
    category = client.post(
        "/api/tags/categories", json={"name": "Character", "color": "#457b9d", "icon": "star"}
    ).json()
    assert category["icon"] == "star"

    updated = client.patch(f"/api/tags/categories/{category['id']}", json={"icon": "heart"}).json()
    assert updated["icon"] == "heart"

    cleared = client.patch(f"/api/tags/categories/{category['id']}", json={"icon": None}).json()
    assert cleared["icon"] is None


def test_tag_icon_round_trips_and_is_independent_of_category(client):
    upload(client, tags="hinata")
    tag = next(t for t in client.get("/api/tags").json() if t["name"] == "hinata")
    assert tag["icon"] is None

    updated = client.patch(f"/api/tags/{tag['id']}", json={"icon": "bookmark"}).json()
    assert updated["icon"] == "bookmark"

    # A tag's own icon is unaffected by later filing it under a category —
    # the category only supplies a *default* for tags with none of their own,
    # resolved client-side, never overwritten server-side.
    category = client.post("/api/tags/categories", json={"name": "Character", "color": "#457b9d"}).json()
    refiled = client.patch(f"/api/tags/{tag['id']}", json={"category_id": category["id"]}).json()
    assert refiled["icon"] == "bookmark"

    cleared = client.patch(f"/api/tags/{tag['id']}", json={"icon": None}).json()
    assert cleared["icon"] is None


def test_graph_node_carries_the_tags_own_icon_not_the_categorys(client):
    category = client.post(
        "/api/tags/categories", json={"name": "Character", "color": "#457b9d", "icon": "star"}
    ).json()
    upload(client, tags="hinata")
    tag = next(t for t in client.get("/api/tags").json() if t["name"] == "hinata")
    client.patch(f"/api/tags/{tag['id']}", json={"category_id": category["id"]})

    node = next(n for n in client.get("/api/tags/graph").json()["nodes"] if n["id"] == tag["id"])
    # The node's own `icon` field stays None; the category (embedded in full)
    # is what the frontend falls back to, the same as it does for `color`.
    assert node["icon"] is None
    assert node["category"]["icon"] == "star"
