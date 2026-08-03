"""Graph rules: pruning a computed edge that a more specific path already explains.

The running example throughout: a pin tagged Category=Anime, Show=Haikyu,
Character=Hinata. Raw co-occurrence draws all three edges (Anime-Haikyu,
Anime-Hinata, Haikyu-Hinata); a rule says the direct Anime-Hinata edge is
redundant once Hinata already connects to a Show tag.
"""

from __future__ import annotations

from conftest import upload


def make_categories(client):
    category = client.post("/api/tags/categories", json={"name": "Category", "color": "#111111"}).json()
    show = client.post("/api/tags/categories", json={"name": "Show", "color": "#222222"}).json()
    character = client.post("/api/tags/categories", json={"name": "Character", "color": "#333333"}).json()
    return category, show, character


def edge_set(graph):
    names = {n["id"]: n["name"] for n in graph["nodes"]}
    return {frozenset((names[e["source"]], names[e["target"]])) for e in graph["edges"]}


def test_all_three_edges_exist_without_a_rule(client):
    category, show, character = make_categories(client)
    client.post("/api/tags", json={"name": "anime", "category_id": category["id"]})
    client.post("/api/tags", json={"name": "haikyu", "category_id": show["id"]})
    client.post("/api/tags", json={"name": "hinata", "category_id": character["id"]})
    upload(client, tags="anime, haikyu, hinata")

    edges = edge_set(client.get("/api/tags/graph").json())
    assert frozenset(("anime", "haikyu")) in edges
    assert frozenset(("anime", "hinata")) in edges
    assert frozenset(("haikyu", "hinata")) in edges


def test_rule_suppresses_only_the_redundant_edge(client):
    category, show, character = make_categories(client)
    client.post("/api/tags", json={"name": "anime", "category_id": category["id"]})
    client.post("/api/tags", json={"name": "haikyu", "category_id": show["id"]})
    client.post("/api/tags", json={"name": "hinata", "category_id": character["id"]})
    upload(client, tags="anime, haikyu, hinata")

    rule = client.post(
        "/api/tags/graph-rules",
        json={
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": show["id"],
        },
    )
    assert rule.status_code == 201
    assert rule.json()["from_category"]["name"] == "Category"
    assert rule.json()["to_category"]["name"] == "Character"
    assert rule.json()["via_category"]["name"] == "Show"

    edges = edge_set(client.get("/api/tags/graph").json())
    assert frozenset(("anime", "hinata")) not in edges
    # The path that explains it stays intact.
    assert frozenset(("anime", "haikyu")) in edges
    assert frozenset(("haikyu", "hinata")) in edges


def test_rule_does_not_suppress_when_the_mediator_is_absent(client):
    """A character with no Show tag on the same pin keeps its direct edge —
    there is nothing for the rule to consider redundant."""
    category, show, character = make_categories(client)
    client.post("/api/tags", json={"name": "anime", "category_id": category["id"]})
    client.post("/api/tags", json={"name": "hinata", "category_id": character["id"]})
    upload(client, tags="anime, hinata")

    client.post(
        "/api/tags/graph-rules",
        json={
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": show["id"],
        },
    )

    edges = edge_set(client.get("/api/tags/graph").json())
    assert frozenset(("anime", "hinata")) in edges


def test_duplicate_rule_returns_the_existing_one(client):
    category, show, character = make_categories(client)
    body = {
        "from_category_id": category["id"],
        "to_category_id": character["id"],
        "via_category_id": show["id"],
    }
    first = client.post("/api/tags/graph-rules", json=body).json()
    second = client.post("/api/tags/graph-rules", json=body).json()
    assert first["id"] == second["id"]
    assert len(client.get("/api/tags/graph-rules").json()) == 1


def test_rule_creation_rejects_an_unknown_category(client):
    category, show, _character = make_categories(client)
    response = client.post(
        "/api/tags/graph-rules",
        json={"from_category_id": category["id"], "to_category_id": 999, "via_category_id": show["id"]},
    )
    assert response.status_code == 404


def test_deleting_a_rule(client):
    category, show, character = make_categories(client)
    rule = client.post(
        "/api/tags/graph-rules",
        json={
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": show["id"],
        },
    ).json()
    assert client.delete(f"/api/tags/graph-rules/{rule['id']}").status_code == 204
    assert client.get("/api/tags/graph-rules").json() == []


def test_deleting_a_category_cascades_the_rule(client):
    category, show, character = make_categories(client)
    client.post(
        "/api/tags/graph-rules",
        json={
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": show["id"],
        },
    )
    client.delete(f"/api/tags/categories/{show['id']}")
    assert client.get("/api/tags/graph-rules").json() == []


def test_rule_without_a_name_gets_a_composed_default(client):
    category, show, character = make_categories(client)
    rule = client.post(
        "/api/tags/graph-rules",
        json={
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": show["id"],
        },
    ).json()
    assert rule["name"] == "Category ✕ Character via Show"


def test_rule_can_be_given_an_explicit_name(client):
    category, show, character = make_categories(client)
    rule = client.post(
        "/api/tags/graph-rules",
        json={
            "name": "Hide anime→character",
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": show["id"],
        },
    ).json()
    assert rule["name"] == "Hide anime→character"
    assert client.get("/api/tags/graph-rules").json()[0]["name"] == "Hide anime→character"


def test_rule_creation_rejects_reused_categories(client):
    category, show, _character = make_categories(client)
    response = client.post(
        "/api/tags/graph-rules",
        json={"from_category_id": category["id"], "to_category_id": show["id"], "via_category_id": show["id"]},
    )
    assert response.status_code == 400


def test_patch_renames_a_rule(client):
    category, show, character = make_categories(client)
    rule = client.post(
        "/api/tags/graph-rules",
        json={
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": show["id"],
        },
    ).json()
    renamed = client.patch(f"/api/tags/graph-rules/{rule['id']}", json={"name": "My rule"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "My rule"

    # Clearing the name reverts to the composed default rather than showing blank.
    cleared = client.patch(f"/api/tags/graph-rules/{rule['id']}", json={"name": ""}).json()
    assert cleared["name"] == "Category ✕ Character via Show"


def test_patch_can_recategorize_a_rule(client):
    category, show, character = make_categories(client)
    other = client.post("/api/tags/categories", json={"name": "Other", "color": "#444444"}).json()
    rule = client.post(
        "/api/tags/graph-rules",
        json={
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": show["id"],
        },
    ).json()

    updated = client.patch(
        f"/api/tags/graph-rules/{rule['id']}", json={"via_category_id": other["id"]}
    )
    assert updated.status_code == 200
    assert updated.json()["via_category"]["name"] == "Other"
    assert updated.json()["from_category"]["name"] == "Category"


def test_patch_rejects_reused_categories(client):
    category, show, character = make_categories(client)
    rule = client.post(
        "/api/tags/graph-rules",
        json={
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": show["id"],
        },
    ).json()
    response = client.patch(f"/api/tags/graph-rules/{rule['id']}", json={"via_category_id": category["id"]})
    assert response.status_code == 400


def test_patch_rejects_a_clash_with_another_rule(client):
    category, show, character = make_categories(client)
    other = client.post("/api/tags/categories", json={"name": "Other", "color": "#444444"}).json()
    client.post(
        "/api/tags/graph-rules",
        json={
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": show["id"],
        },
    )
    second = client.post(
        "/api/tags/graph-rules",
        json={
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": other["id"],
        },
    ).json()

    response = client.patch(
        f"/api/tags/graph-rules/{second['id']}", json={"via_category_id": show["id"]}
    )
    assert response.status_code == 409


def test_patch_rejects_an_unknown_category(client):
    category, show, character = make_categories(client)
    rule = client.post(
        "/api/tags/graph-rules",
        json={
            "from_category_id": category["id"],
            "to_category_id": character["id"],
            "via_category_id": show["id"],
        },
    ).json()
    response = client.patch(f"/api/tags/graph-rules/{rule['id']}", json={"via_category_id": 999})
    assert response.status_code == 404


def test_patch_rejects_an_unknown_rule(client):
    response = client.patch("/api/tags/graph-rules/999", json={"name": "x"})
    assert response.status_code == 404
