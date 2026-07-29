"""Discovery search templates: type the subject, send the boilerplate."""

from __future__ import annotations

import pytest

from app.routers.discover import apply_template
from app.services import settings_store


@pytest.mark.parametrize(
    "template,typed,expected",
    [
        ("{query}", "Shōyō Hinata", "Shōyō Hinata"),
        ("{query} artwork", "Shōyō Hinata", "Shōyō Hinata artwork"),
        ('"{query}" artwork', "Shōyō Hinata", '"Shōyō Hinata" artwork'),
        ("{query} artwork -pinterest", "cats", "cats artwork -pinterest"),
        ("{query} site:artstation.com", "cats", "cats site:artstation.com"),
        # Whitespace the user leaves behind should not reach the engine.
        ("{query} artwork", "  cats  ", "cats artwork"),
        # A template without the placeholder would drop the search entirely;
        # the query is used unchanged rather than silently discarded.
        ("artwork", "cats", "cats"),
        ("", "cats", "cats"),
    ],
)
def test_apply_template(template, typed, expected):
    assert apply_template(template, typed) == expected


def test_templates_endpoint_lists_active_saved_and_recommended(client):
    data = client.get("/api/discover/templates").json()
    assert data["active"] == "{query}"
    assert data["saved"] == []
    assert len(data["recommended"]) == len(settings_store.RECOMMENDED_TEMPLATES)
    for entry in data["recommended"]:
        assert "{query}" in entry["template"]
        assert entry["name"] and entry["note"]


def test_saving_and_activating_a_template(client):
    client.put(
        "/api/settings",
        json={
            "values": {
                "discovery.templates": [{"name": "Mine", "template": "{query} concept art"}],
                "discovery.query_template": "{query} concept art",
            }
        },
    )
    data = client.get("/api/discover/templates").json()
    assert data["active"] == "{query} concept art"
    assert data["saved"] == [{"name": "Mine", "template": "{query} concept art"}]


def test_a_template_without_the_placeholder_is_refused(client):
    """Otherwise every search would return the same results, confusingly."""
    response = client.put("/api/settings", json={"values": {"discovery.query_template": "artwork"}})
    assert response.status_code == 400
    assert "{query}" in response.json()["detail"]


def test_saved_templates_are_validated(client):
    bad_shape = client.put("/api/settings", json={"values": {"discovery.templates": [{"name": "x"}]}})
    assert bad_shape.status_code == 400

    bad_pattern = client.put(
        "/api/settings",
        json={"values": {"discovery.templates": [{"name": "x", "template": "artwork"}]}},
    )
    assert bad_pattern.status_code == 400


def test_discovery_still_requires_configuration(client):
    """Templates are inert until Discovery itself is set up."""
    client.put("/api/settings", json={"values": {"discovery.query_template": "{query} artwork"}})
    assert client.get("/api/discover", params={"q": "cats"}).status_code == 409
