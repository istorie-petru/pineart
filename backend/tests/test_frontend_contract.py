"""Contract tests: the exact requests the frontend makes, and the fields it reads.

The frontend is a separate build with its own types; nothing forces the two to
agree at compile time. These tests pin the parts of the API surface the UI
actually depends on, so a backend rename shows up here rather than as an
undefined value in the browser.

Each assertion below corresponds to a real call site in frontend/src.
"""

from __future__ import annotations

from conftest import upload

# Fields read by frontend/src/components/card.ts and itemModal.ts.
ITEM_FIELDS = {
    "id", "hash", "title", "description", "width", "height", "filesize",
    "mime_type", "dominant_color", "orientation", "parent_item_id",
    "derivative_target", "is_deleted", "deleted_at", "added_at", "tags", "urls",
}


def test_item_shape_matches_the_frontend_type(client):
    item = upload(client, title="Contract", tags="alpha")["item"]

    assert ITEM_FIELDS <= set(item)
    assert set(item["urls"]) == {"thumb", "display", "download"}
    assert set(item["tags"][0]) >= {"id", "name", "slug", "color"}
    # card.ts sets aspect-ratio from these before the image loads.
    assert isinstance(item["width"], int) and isinstance(item["height"], int)


def test_grid_pagination_contract(client):
    for i in range(3):
        upload(client, image_kwargs={"seed": i, "size": (300 + i, 200)})

    page = client.get("/api/items", params={"limit": 2, "sort": "added_at"}).json()
    assert set(page) == {"items", "next_cursor", "total"}
    assert page["next_cursor"]

    # components/grid.ts passes next_cursor straight back as `cursor`.
    second = client.get("/api/items", params={"limit": 2, "cursor": page["next_cursor"]}).json()
    assert {i["id"] for i in second["items"]}.isdisjoint({i["id"] for i in page["items"]})


def test_search_bar_token_grammar_is_what_the_ui_writes(client):
    """searchBar.ts writes exactly these token forms into the input."""
    item = upload(client, title="Tall", tags="landscape", image_kwargs={"size": (300, 700)})["item"]
    color = client.get(f"/api/items/{item['id']}").json()["dominant_color"]

    query = f"tag:landscape orientation:portrait color:{color}"
    result = client.get("/api/items", params={"q": query}).json()
    assert [i["id"] for i in result["items"]] == [item["id"]]


def test_board_shape_matches_the_frontend_type(client):
    board = client.post("/api/boards", json={"name": "Contract board"}).json()
    assert {
        "id", "name", "slug", "description", "cover_item_id", "cover_url",
        "is_dynamic", "item_count", "query_tags", "match_mode", "subboard_tags",
    } <= set(board)


def test_settings_expose_the_derived_profile_urls(client):
    """views/boards.ts renders the header straight from these two keys."""
    settings = client.get("/api/settings").json()
    for key in (
        "profile.display_name", "profile.description", "profile.avatar_url",
        "profile.banner_url", "appearance.theme", "appearance.accent_color",
        "collection.page_size", "collection.default_sort", "discovery.enabled",
        "discovery.searxng_url",
    ):
        assert key in settings, key


def test_graph_payload_matches_the_d3_binding(client):
    upload(client, tags="a, b")
    graph = client.get("/api/tags/graph").json()

    assert set(graph) == {"nodes", "edges"}
    assert set(graph["nodes"][0]) == {
        "id", "name", "color", "category", "link_url", "nsfw", "icon", "usage_count",
    }
    assert set(graph["edges"][0]) == {"source", "target", "weight"}
    # tagGraph.ts uses forceLink().id(d => d.id), so source/target must be the
    # node ids, not indices or objects.
    node_ids = {n["id"] for n in graph["nodes"]}
    assert graph["edges"][0]["source"] in node_ids
    assert graph["edges"][0]["target"] in node_ids


def test_crop_accepts_the_coordinates_cropperjs_produces(client):
    """cropModal.ts sends integer pixel coordinates in the original's scale."""
    source = upload(client, image_kwargs={"size": (1600, 1600)})["item"]
    derived = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 120, "y": 80, "w": 400, "h": 400, "target": "avatar"},
    )
    assert derived.status_code == 201
    assert derived.json()["parent_item_id"] == source["id"]


def test_bulk_import_result_shape(client):
    """main.ts reads created/duplicates/failed to build its summary toast."""
    from conftest import make_image

    files = [("files", (f"{i}.png", make_image(seed=i, size=(300 + i, 200)), "image/png")) for i in range(2)]
    result = client.post("/api/items/bulk-import", files=files).json()
    assert set(result) == {"created", "duplicates", "failed"}
