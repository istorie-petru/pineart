"""Exclusions and presence filters in the search grammar."""

from __future__ import annotations

from conftest import make_solid_image, upload


def ids(client, query):
    return {i["id"] for i in client.get("/api/items", params={"q": query}).json()["items"]}


def test_excluding_a_tag(client):
    keep = upload(client, tags="landscape", image_kwargs={"seed": 1})["item"]
    drop = upload(client, tags="landscape, portrait", image_kwargs={"seed": 2})["item"]

    assert ids(client, "tag:landscape -tag:portrait") == {keep["id"]}
    assert ids(client, "-tag:portrait") == {keep["id"]}
    assert ids(client, "tag:landscape") == {keep["id"], drop["id"]}


def test_excluding_a_tag_keeps_untagged_items(client):
    """NOT EXISTS, not NOT IN — the latter would drop everything."""
    untagged = upload(client, image_kwargs={"seed": 1})["item"]
    tagged = upload(client, tags="portrait", image_kwargs={"seed": 2})["item"]

    result = ids(client, "-tag:portrait")
    assert untagged["id"] in result
    assert tagged["id"] not in result


def test_excluding_by_accented_name_or_slug(client):
    keep = upload(client, image_kwargs={"seed": 1})["item"]
    upload(client, tags="Shōyō Hinata", image_kwargs={"seed": 2})

    assert ids(client, "-tag:shoyo-hinata") == {keep["id"]}
    assert ids(client, '-tag:"Shōyō Hinata"') == {keep["id"]}


def test_excluding_an_orientation(client):
    portrait = upload(client, image_kwargs={"seed": 1, "size": (300, 700)})["item"]
    landscape = upload(client, image_kwargs={"seed": 2, "size": (700, 300)})["item"]

    assert ids(client, "-orientation:landscape") == {portrait["id"]}
    assert ids(client, "-orientation:portrait") == {landscape["id"]}


def test_excluding_a_colour(client):
    red = upload(client, data=make_solid_image((230, 57, 70)))["item"]
    blue = upload(client, data=make_solid_image((30, 60, 220)))["item"]

    assert ids(client, "-color:red") == {blue["id"]}
    assert ids(client, "-color:blue") == {red["id"]}


def test_is_untagged_and_is_tagged(client):
    bare = upload(client, image_kwargs={"seed": 1})["item"]
    tagged = upload(client, tags="ink", image_kwargs={"seed": 2})["item"]

    assert ids(client, "is:untagged") == {bare["id"]}
    assert ids(client, "is:tagged") == {tagged["id"]}
    # Negating one is the other; the query builder only sees the positive form.
    assert ids(client, "-is:tagged") == {bare["id"]}
    assert ids(client, "-is:untagged") == {tagged["id"]}


def test_is_titled_and_untitled(client):
    named = upload(client, title="Rooftops", image_kwargs={"seed": 1})["item"]
    bare = upload(client, image_kwargs={"seed": 2})["item"]

    assert ids(client, "is:titled") == {named["id"]}
    assert ids(client, "is:untitled") == {bare["id"]}


def test_combining_positive_and_negative_filters(client):
    wanted = upload(client, tags="landscape", title="Keep", image_kwargs={"seed": 1, "size": (700, 300)})["item"]
    upload(client, tags="landscape, wip", image_kwargs={"seed": 2, "size": (700, 300)})
    upload(client, tags="landscape", image_kwargs={"seed": 3, "size": (300, 700)})

    assert ids(client, "tag:landscape -tag:wip orientation:landscape is:titled") == {wanted["id"]}


def test_a_bare_minus_is_treated_as_text_not_syntax(client):
    """"-" on its own must not silently become an empty exclusion."""
    upload(client, title="well-known", image_kwargs={"seed": 1})
    response = client.get("/api/items", params={"q": "- known"})
    assert response.status_code == 200


def test_unknown_is_value_is_ignored(client):
    upload(client)
    assert client.get("/api/items", params={"q": "is:sideways"}).json()["total"] == 1
