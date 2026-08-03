"""Settings key/value endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Board, Item, ItemTag
from ..schemas import SettingsIn
from ..services import search, settings_store

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _decorate(db: Session, values: dict[str, Any]) -> dict[str, Any]:
    """Attach ready-to-use image URLs for the avatar/banner item references.

    Saves the frontend a second round-trip on every page load just to turn two
    item ids into two `<img src>` values.
    """
    out = dict(values)
    for key, field in (
        ("profile.avatar_item_id", "profile.avatar_url"),
        ("profile.banner_item_id", "profile.banner_url"),
    ):
        item_id = values.get(key)
        out[field] = None
        if item_id and db.get(Item, int(item_id)) is not None:
            out[field] = f"/api/items/{int(item_id)}/file/display"
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
