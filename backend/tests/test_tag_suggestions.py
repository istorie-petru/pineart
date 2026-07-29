"""Fuzzy tag suggestions — the autocomplete behind every tag field."""

from __future__ import annotations

import pytest
from conftest import upload


@pytest.fixture
def tagged(client):
    """A small collection with tags that are easy to mistype or half-remember."""
    upload(client, tags="Shōyō Hinata, volleyball", image_kwargs={"seed": 1})
    upload(client, tags="Shōyō Hinata", image_kwargs={"seed": 2})
    upload(client, tags="landscape, plein-air", image_kwargs={"seed": 3})
    upload(client, tags="portrait-study", image_kwargs={"seed": 4})
    upload(client, tags="colour theory", image_kwargs={"seed": 5})
    upload(client, tags="日本画", image_kwargs={"seed": 6})
    return client


def names(client, query, limit=12):
    return [
        tag["name"]
        for tag in client.get("/api/tags/suggest", params={"q": query, "limit": limit}).json()
    ]


def test_prefix_match(tagged):
    assert "landscape" in names(tagged, "land")


def test_accents_are_optional(tagged):
    """Someone without an ō on their keyboard still has to be able to find it."""
    assert "Shōyō Hinata" in names(tagged, "shoyo")
    assert "Shōyō Hinata" in names(tagged, "Shōyō")


def test_matches_a_word_from_the_middle(tagged):
    """"hinata" is not a prefix of the tag, but it is what someone would type."""
    assert "Shōyō Hinata" in names(tagged, "hinata")


def test_word_order_does_not_matter(tagged):
    assert "Shōyō Hinata" in names(tagged, "hinata shoyo")


def test_typos_still_find_the_tag(tagged):
    assert "landscape" in names(tagged, "landscpae")
    assert "portrait-study" in names(tagged, "portrat")


def test_separator_style_does_not_matter(tagged):
    assert "portrait-study" in names(tagged, "portrait study")
    assert "colour theory" in names(tagged, "colour-theory")


def test_non_latin_tags_are_suggested(tagged):
    assert "日本画" in names(tagged, "日本")


def test_unrelated_queries_return_nothing(tagged):
    assert names(tagged, "quantum chromodynamics") == []


def test_exact_match_ranks_first(tagged):
    assert names(tagged, "landscape")[0] == "landscape"


def test_shorter_tags_rank_above_longer_ones(client):
    upload(client, tags="ink, inktober sketches, inkwell studies")
    assert names(client, "ink")[0] == "ink"


def test_usage_count_breaks_ties(tagged):
    """Two equally good matches: the one you actually use should come first."""
    results = tagged.get("/api/tags/suggest", params={"q": ""}).json()
    counts = [tag["usage_count"] for tag in results]
    assert counts == sorted(counts, reverse=True)
    assert results[0]["name"] == "Shōyō Hinata"  # used twice, everything else once


def test_empty_query_returns_the_most_used(tagged):
    assert names(tagged, "")[0] == "Shōyō Hinata"


def test_limit_is_respected_and_capped(tagged):
    assert len(names(tagged, "", limit=2)) == 2
    assert tagged.get("/api/tags/suggest", params={"q": "", "limit": 999}).status_code == 200


def test_suggestions_carry_what_the_ui_renders(tagged):
    entry = tagged.get("/api/tags/suggest", params={"q": "land"}).json()[0]
    assert set(entry) == {"id", "name", "slug", "color", "category", "link_url", "usage_count"}
