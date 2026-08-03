"""Tests for the behaviour added while closing the architecture-document gaps."""

from __future__ import annotations

from conftest import make_solid_image, upload


import pytest

from app.services.search import _matches


def test_named_colors_filter_by_family(client):
    """The UI writes `color:red`, not `color:#e63946` — the bar is for humans."""
    red = upload(client, data=make_solid_image((230, 57, 70)))["item"]
    blue = upload(client, data=make_solid_image((30, 60, 220)))["item"]
    green = upload(client, data=make_solid_image((60, 150, 70)))["item"]

    assert red["dominant_color"].startswith("#")

    def ids(query: str) -> set[int]:
        return {i["id"] for i in client.get("/api/items", params={"q": query}).json()["items"]}

    assert ids("color:red") == {red["id"]}
    assert ids("color:blue") == {blue["id"]}
    assert ids("color:green") == {green["id"]}


@pytest.mark.parametrize(
    "dominant,target,expected",
    [
        # A muted red is still red. This is the case that RGB Euclidean distance
        # got wrong: these two sit 93 units apart, well past any usable
        # threshold, while a person calls both of them red.
        ("#9f686c", "red", True),
        ("#e63946", "red", True),
        ("#f4a261", "red", False),
        # Blue spans a much wider hue range than orange does, which is why the
        # families are ranges rather than one symmetric tolerance.
        ("#5e689d", "blue", True),
        ("#457b9d", "blue", True),
        ("#2a9d8f", "teal", True),
        ("#2a9d8f", "green", False),
        # Achromatic families are matched on lightness; hue is noise down there,
        # so a dark red must not fall into "black".
        ("#2b2b2b", "black", True),
        ("#8d1a1a", "black", False),
        ("#f2f0ec", "white", True),
        ("#8d8d8d", "grey", True),
        # A raw hex filter still works, matching a neighbourhood around it.
        ("#9f686c", "#e63946", True),
    ],
)
def test_color_family_matching(dominant, target, expected):
    assert _matches(dominant, target) is expected


def test_unknown_color_name_is_not_treated_as_a_filter(client):
    upload(client)
    # "chartreuse" is not a known family and is not hex; it must be ignored
    # rather than silently matching everything or nothing.
    result = client.get("/api/items", params={"q": "color:chartreuse"}).json()
    assert result["total"] == 1


def test_crop_can_resize_the_result(client):
    source = upload(client, image_kwargs={"size": (1200, 900)})["item"]
    derived = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 800, "h": 600, "output_width": 400},
    ).json()

    assert (derived["width"], derived["height"]) == (400, 300)
    assert derived["parent_item_id"] == source["id"]


def test_crop_refuses_to_enlarge(client):
    """Upscaling invents detail; the slider in the UI cannot ask for it either."""
    source = upload(client, image_kwargs={"size": (600, 400)})["item"]
    response = client.post(
        f"/api/items/{source['id']}/crop",
        json={"x": 0, "y": 0, "w": 300, "h": 200, "output_width": 1200},
    )
    assert response.status_code == 400
    assert "enlarge" in response.json()["detail"]


def test_single_item_purge_requires_it_to_be_trashed_first(client):
    item = upload(client)["item"]

    too_soon = client.delete(f"/api/trash/{item['id']}")
    assert too_soon.status_code == 400

    client.delete(f"/api/items/{item['id']}")
    assert client.delete(f"/api/trash/{item['id']}").status_code == 204
    assert client.get(f"/api/items/{item['id']}").status_code == 404
    assert client.get("/api/trash").json()["total"] == 0


def test_single_item_purge_removes_the_files(client):
    from app.services import images

    item = upload(client)["item"]
    directory = images.storage_dir_for(item["hash"])
    assert list(directory.glob(f"{item['hash']}*"))

    client.delete(f"/api/items/{item['id']}")
    client.delete(f"/api/trash/{item['id']}")
    assert list(directory.glob(f"{item['hash']}*")) == []


def test_title_and_description_round_trip_into_search(client):
    """The UI can now set these, so the features that depend on them work."""
    item = upload(client)["item"]
    assert item["title"] is None

    client.patch(f"/api/items/{item['id']}", json={"title": "Harbour at dusk"})
    client.patch(f"/api/items/{item['id']}", json={"description": "watercolour study"})

    assert [i["id"] for i in client.get("/api/search", params={"q": "harbour"}).json()["items"]] == [item["id"]]
    assert [i["id"] for i in client.get("/api/search", params={"q": "watercolour"}).json()["items"]] == [item["id"]]

    by_title = client.get("/api/items", params={"sort": "title"}).json()["items"]
    assert by_title[0]["title"] == "Harbour at dusk"
