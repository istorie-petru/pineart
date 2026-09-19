"""Settings key/value endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select, text, update
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Board, Item, ItemTag, Link, Tag, TagCategory
from ..schemas import SettingsIn
from ..services import images, search, settings_store

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _decorate(db: Session, values: dict[str, Any]) -> dict[str, Any]:
    """Attach ready-to-use image URLs for the avatar/banner item references.

    Saves the frontend a second round-trip on every page load just to turn two
    item ids into two `<img src>` values.

    `/file/hero` (2026-09-18, direct report: "avatar or banner... are
    supposed to be big and beautiful, not lower version quality") rather than
    `/file/display` -- these crops get their own much higher quality/size
    derivative (images.py's HERO_TARGET_SUFFIXES), since there's exactly one
    of each per profile rather than thousands like a grid item.
    """
    out = dict(values)
    for key, field in (
        ("profile.avatar_item_id", "profile.avatar_url"),
        ("profile.banner_item_id", "profile.banner_url"),
    ):
        item_id = values.get(key)
        out[field] = None
        if item_id and db.get(Item, int(item_id)) is not None:
            out[field] = f"/api/items/{int(item_id)}/file/hero"
    return out


@router.get("")
def get_settings(db: Session = Depends(get_db)) -> dict[str, Any]:
    return _decorate(db, settings_store.get_all(db))


@router.put("")
def put_settings(payload: SettingsIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        updated = settings_store.set_many(db, payload.values)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _decorate(db, updated)


@router.post("/reset")
def reset_tags_and_covers(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Untags every item and clears every cover image (profile avatar/banner,
    every board's cover) in one action, for starting a fresh round of tagging
    and curation without losing the collection itself.

    What is *not* touched, deliberately: the items/files themselves, the
    Tag/TagCategory definitions (so the taxonomy you built stays there to
    reuse — this clears what's applied, not what exists), boards (still
    there, just without a cover image), and everything else in settings.
    """
    affected_items = list(db.scalars(select(Item).join(Item.tags)).all())
    db.execute(delete(ItemTag))
    db.execute(update(Board).values(cover_item_id=None))
    settings_store.set_many(db, {"profile.avatar_item_id": None, "profile.banner_item_id": None})

    # The FTS index's `tags` column has to lose those tags too, or a search
    # for a tag name would keep matching items that no longer carry it.
    for item in affected_items:
        search.reindex_item(db, item)
    db.commit()

    return _decorate(db, settings_store.get_all(db))


@router.post("/delete-all")
def delete_all(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Wipes the entire collection: every item and its files on disk, every
    board, every tag/category/graph-rule, and every link.

    Distinct from `/reset` above — that one only clears what's *applied*
    (tags, covers) and leaves the collection itself intact. This clears what
    *exists*. Login, session and the rest of settings (theme, page size,
    Discovery config, …) are untouched, so the app comes back as an empty
    collection, not a freshly-installed one.
    """
    storage_paths = set(db.scalars(select(Item.storage_path)).all())

    # Boards and tags cascade their own join tables (board_items,
    # board_query_tags, board_subboard_tags, item_tags) and — for tag
    # categories — tag_graph_rules, all declared ON DELETE CASCADE.
    db.execute(delete(Board))
    db.execute(delete(Tag))
    db.execute(delete(TagCategory))
    db.execute(delete(Link))
    db.execute(delete(Item))
    db.execute(text("DELETE FROM items_fts"))
    settings_store.set_many(db, {"profile.avatar_item_id": None, "profile.banner_item_id": None})
    db.commit()

    for path in storage_paths:
        images.delete_files(path)

    return _decorate(db, settings_store.get_all(db))
