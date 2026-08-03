"""Creator links: a single outbound URL, only meaningful for categories that opt in."""

from __future__ import annotations


def test_category_can_enable_links(client):
    category = client.post(
        "/api/tags/categories", json={"name": "Creator", "color": "#e63946", "links_enabled": True}
    ).json()
    assert category["links_enabled"] is True

    default = client.post("/api/tags/categories", json={"name": "Media", "color": "#457b9d"}).json()
    assert default["links_enabled"] is False


def test_tag_can_carry_a_link_url(client):
    creator = client.post(
        "/api/tags/categories", json={"name": "Creator", "color": "#e63946", "links_enabled": True}
    ).json()
    tag = client.post(
        "/api/tags",
        json={"name": "some-artist", "category_id": creator["id"], "link_url": "https://example.com/artist"},
    ).json()
    assert tag["link_url"] == "https://example.com/artist"
    assert tag["category"]["links_enabled"] is True


def test_link_url_must_look_like_a_url(client):
    response = client.post("/api/tags", json={"name": "bad-link", "link_url": "not-a-url"})
    assert response.status_code == 422


def test_link_url_can_be_patched_and_cleared(client):
    tag = client.post("/api/tags", json={"name": "artist"}).json()
    assert tag["link_url"] is None

    linked = client.patch(f"/api/tags/{tag['id']}", json={"link_url": "https://example.com"}).json()
    assert linked["link_url"] == "https://example.com"

    cleared = client.patch(f"/api/tags/{tag['id']}", json={"link_url": ""}).json()
    assert cleared["link_url"] is None


def test_a_tag_not_sending_link_url_keeps_its_existing_one(client):
    """Distinguishing 'omitted' from 'sent empty' is the whole point of the fix —
    an unrelated rename must not silently wipe the link."""
    tag = client.post("/api/tags", json={"name": "artist", "link_url": "https://example.com"}).json()
    renamed = client.patch(f"/api/tags/{tag['id']}", json={"name": "artist-renamed"}).json()
    assert renamed["link_url"] == "https://example.com"


def test_suggest_carries_the_link(client):
    client.post("/api/tags", json={"name": "artist", "link_url": "https://example.com"})
    results = client.get("/api/tags/suggest", params={"q": "artist"}).json()
    assert results[0]["link_url"] == "https://example.com"


def test_link_survives_even_if_category_is_later_cleared(client):
    """Clearing a tag's category is not destructive to data that isn't about
    categorization — the link just stops being editable through the
    links-enabled UI, it is not deleted."""
    creator = client.post(
        "/api/tags/categories", json={"name": "Creator", "color": "#e63946", "links_enabled": True}
    ).json()
    tag = client.post(
        "/api/tags",
        json={"name": "artist", "category_id": creator["id"], "link_url": "https://example.com"},
    ).json()
    updated = client.patch(f"/api/tags/{tag['id']}", json={"clear_category": True}).json()
    assert updated["category"] is None
    assert updated["link_url"] == "https://example.com"
