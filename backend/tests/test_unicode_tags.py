"""Tag names keep their original spelling; slugs make them findable."""
from __future__ import annotations

import pytest
from conftest import upload

from app.services.tags import slugify


@pytest.mark.parametrize(
    "name,expected",
    [
        ("Shōyō Hinata", "shoyo-hinata"),
        ("Café Terrace", "cafe-terrace"),
        ("Zażółć gęślą jaźń", "zazolc-gesla-jazn"),
        ("Ångström", "angstrom"),
        ("  spaced   out  ", "spaced-out"),
        ("Art Deco!!", "art-deco"),
        # No ASCII equivalent: the casefolded original is still a fine handle.
        ("日本画", "日本画"),
        ("Кандинский", "кандинский"),
    ],
)
def test_slugify(name, expected):
    assert slugify(name) == expected


def test_display_name_is_preserved_exactly(client):
    item = upload(client, tags="Shōyō Hinata")["item"]
    tag = client.get("/api/tags").json()[0]
    assert tag["name"] == "Shōyō Hinata"
    assert tag["slug"] == "shoyo-hinata"
    assert [t["name"] for t in item["tags"]] == ["Shōyō Hinata"]


def test_spellings_that_share_a_slug_are_one_tag(client):
    """The whole point of the slug: one concept, not three near-duplicates."""
    upload(client, tags="Shōyō Hinata", image_kwargs={"seed": 1})
    upload(client, tags="shoyo hinata", image_kwargs={"seed": 2})
    upload(client, tags="Shoyo-Hinata", image_kwargs={"seed": 3})

    tags = client.get("/api/tags").json()
    assert len(tags) == 1
    # First spelling wins; a later variant must not rewrite a curated name.
    assert tags[0]["name"] == "Shōyō Hinata"


def test_filtering_works_by_slug_or_by_accented_name(client):
    item = upload(client, tags="Shōyō Hinata")["item"]
    upload(client, tags="something else", image_kwargs={"seed": 5})

    for query in ("tag:shoyo-hinata", 'tag:"Shōyō Hinata"', 'tag:"shoyo hinata"'):
        found = client.get("/api/items", params={"q": query}).json()
        assert [i["id"] for i in found["items"]] == [item["id"]], query


def test_full_text_search_finds_either_form(client):
    item = upload(client, tags="Shōyō Hinata")["item"]
    for query in ("shoyo", "hinata", "shoyo-hinata", "Shōyō"):
        found = client.get("/api/search", params={"q": query}).json()
        assert [i["id"] for i in found["items"]] == [item["id"]], query


def test_untagging_accepts_any_spelling(client):
    item = upload(client, tags="Shōyō Hinata")["item"]
    client.post("/api/items/bulk", json={"item_ids": [item["id"]], "action": "untag", "tags": ["shoyo-hinata"]})
    assert client.get(f"/api/items/{item['id']}").json()["tags"] == []


def test_rename_to_a_colliding_normalized_form_is_refused(client):
    a = client.post("/api/tags", json={"name": "Shōyō Hinata"}).json()
    b = client.post("/api/tags", json={"name": "Kageyama"}).json()
    assert a["id"] != b["id"]
    response = client.patch(f"/api/tags/{b['id']}", json={"name": "shoyo hinata"})
    assert response.status_code == 409
    assert "shoyo-hinata" in response.json()["detail"]


def test_cjk_tags_round_trip(client):
    item = upload(client, tags="日本画")["item"]
    assert [t["name"] for t in item["tags"]] == ["日本画"]
    found = client.get("/api/items", params={"q": "tag:日本画"}).json()
    assert [i["id"] for i in found["items"]] == [item["id"]]
