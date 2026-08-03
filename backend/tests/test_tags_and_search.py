from __future__ import annotations

from conftest import upload


def test_multiple_tag_tokens_mean_and_not_or(client):
    both = upload(client, tags="landscape, impressionism", image_kwargs={"seed": 1})["item"]
    upload(client, tags="landscape", image_kwargs={"seed": 2})

    result = client.get("/api/items", params={"q": "tag:landscape tag:impressionism"}).json()
    assert [i["id"] for i in result["items"]] == [both["id"]]


def test_orientation_and_free_text_tokens(client):
    portrait = upload(
        client, title="Tall study", image_kwargs={"seed": 1, "size": (300, 700)}
    )["item"]
    upload(client, title="Wide study", image_kwargs={"seed": 2, "size": (700, 300)})

    result = client.get("/api/items", params={"q": "orientation:portrait study"}).json()
    assert [i["id"] for i in result["items"]] == [portrait["id"]]


def test_color_token_matches_similar_dominant_colors(client):
    red = upload(client, image_kwargs={"seed": 1, "color": (220, 20, 30)})["item"]
    upload(client, image_kwargs={"seed": 2, "color": (20, 30, 220)})

    dominant = client.get(f"/api/items/{red['id']}").json()["dominant_color"]
    result = client.get("/api/items", params={"q": f"color:{dominant}"}).json()
    assert red["id"] in [i["id"] for i in result["items"]]


def test_fts_finds_title_description_and_tags(client):
    item = upload(client, title="Rooftops at dusk", tags="cityscape")["item"]
    client.patch(f"/api/items/{item['id']}", json={"description": "watercolour on cotton"})

    for query in ("rooftop", "watercolour", "cityscape"):
        found = client.get("/api/search", params={"q": query}).json()
        assert [i["id"] for i in found["items"]] == [item["id"]], query


def test_search_query_syntax_is_not_injectable(client):
    """A stray quote or FTS operator must be treated as text, not syntax."""
    upload(client, title="ordinary")
    response = client.get("/api/search", params={"q": 'nonsense" OR items_fts MATCH "a'})
    assert response.status_code == 200
    assert response.json()["items"] == []


def test_tag_rename_keeps_assignments_and_updates_index(client):
    item = upload(client, tags="impresionism")["item"]  # deliberate typo, then fixed
    tag_id = client.get("/api/tags").json()[0]["id"]

    renamed = client.patch(f"/api/tags/{tag_id}", json={"name": "impressionism", "color": "#336699"})
    assert renamed.status_code == 200

    still_tagged = client.get(f"/api/items/{item['id']}").json()
    assert [t["name"] for t in still_tagged["tags"]] == ["impressionism"]
    assert client.get("/api/items", params={"q": "tag:impressionism"}).json()["total"] == 1
    assert [i["id"] for i in client.get("/api/search", params={"q": "impressionism"}).json()["items"]] == [item["id"]]


def test_tag_rename_rejects_a_name_already_in_use(client):
    client.post("/api/tags", json={"name": "one"})
    second = client.post("/api/tags", json={"name": "two"}).json()
    assert client.patch(f"/api/tags/{second['id']}", json={"name": "ONE"}).status_code == 409


def test_tag_names_are_case_insensitive_on_create(client):
    upload(client, tags="Ink", image_kwargs={"seed": 1})
    upload(client, tags="ink", image_kwargs={"seed": 2})
    assert len(client.get("/api/tags").json()) == 1


def test_graph_edges_are_computed_from_co_occurrence(client):
    upload(client, tags="a, b", image_kwargs={"seed": 1})
    upload(client, tags="a, b", image_kwargs={"seed": 2})
    upload(client, tags="a, c", image_kwargs={"seed": 3})

    graph = client.get("/api/tags/graph").json()
    weights = {
        tuple(sorted((e["source"], e["target"]))): e["weight"]
        for e in graph["edges"]
    }
    by_name = {n["name"]: n["id"] for n in graph["nodes"]}

    assert weights[tuple(sorted((by_name["a"], by_name["b"])))] == 2
    assert weights[tuple(sorted((by_name["a"], by_name["c"])))] == 1
    assert tuple(sorted((by_name["b"], by_name["c"]))) not in weights
    assert {n["name"]: n["usage_count"] for n in graph["nodes"]}["a"] == 3


def test_deleted_items_are_excluded_from_graph_weights(client):
    item = upload(client, tags="a, b", image_kwargs={"seed": 1})["item"]
    upload(client, tags="a, b", image_kwargs={"seed": 2})
    client.delete(f"/api/items/{item['id']}")

    edges = client.get("/api/tags/graph").json()["edges"]
    assert edges[0]["weight"] == 1
