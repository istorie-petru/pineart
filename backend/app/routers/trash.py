"""Trash: soft-deleted items, restore, and the retention purge."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, aliased

from ..db import get_db
from ..models import Item
from ..schemas import ItemPage, PurgeResult
from ..serializers import item_out
from ..services import images, queries, search, settings_store

router = APIRouter(prefix="/api/trash", tags=["trash"])


@router.get("", response_model=ItemPage)
def list_trash(
    db: Session = Depends(get_db), cursor: str | None = None, limit: int | None = None
) -> ItemPage:
    stmt = queries.build_query(db, parsed=search.ParsedQuery(), only_deleted=True)
    # A version that went to the trash with its artwork is shown as part of that
    # artwork, not as a card of its own — otherwise trashing one picture with
    # three scans would look like trashing four things. A version deleted on its
    # own still appears, so it can be restored.
    artwork = aliased(Item)
    stmt = stmt.where(
        Item.version_of_id.is_(None)
        | ~select(artwork.id)
        .where(artwork.id == Item.version_of_id, artwork.is_deleted.is_(True))
        .exists()
    )
    page_size = limit or int(settings_store.get(db, "collection.page_size"))
    items, next_cursor, total = queries.paginate(db, stmt, limit=page_size, cursor=cursor)
    return ItemPage(items=[item_out(i) for i in items], next_cursor=next_cursor, total=total)


@router.post("/purge", response_model=PurgeResult)
def purge(db: Session = Depends(get_db), force: bool = False) -> PurgeResult:
    """Hard-delete trashed items past the retention window.

    `force=true` empties the trash immediately regardless of age — the "Empty
    trash now" button. Files are removed only after the row is gone, and only
    when no other item still references the same content hash (a crop derivative
    and its source are distinct rows but never share a hash, so in practice this
    guard only matters if the DB is restored over an existing image directory).
    """
    return PurgeResult(purged=purge_expired(db, force=force))


@router.delete("/{item_id}", status_code=204)
def purge_one(item_id: int, db: Session = Depends(get_db)) -> None:
    """Hard-delete a single trashed item — the per-card "Purge" button.

    Restricted to items already in the trash on purpose: permanent deletion
    should always be a second, deliberate action, never something reachable in
    one click from the collection.
    """
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    if not item.is_deleted:
        raise HTTPException(
            status_code=400, detail="Move the item to the trash before purging it"
        )
    _hard_delete(db, item)


def _hard_delete(db: Session, item: Item) -> None:
    storage_path, item_id = item.storage_path, item.id
    db.delete(item)
    db.commit()
    search.remove_from_index(db, item_id)
    # Only remove files when no surviving row still points at the same file. Two
    # rows can share a path now that keyed crops exist, so the check is on the
    # path rather than on the content hash.
    if not db.scalar(select(Item.id).where(Item.storage_path == storage_path)):
        images.delete_files(storage_path)


def purge_expired(db: Session, *, force: bool = False) -> int:
    retention_days = int(settings_store.get(db, "storage.trash_retention_days"))
    stmt = select(Item).where(Item.is_deleted.is_(True))
    if not force and retention_days > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
        stmt = stmt.where(Item.deleted_at.is_not(None), Item.deleted_at < cutoff)

    doomed = list(db.scalars(stmt).all())
    purged = 0
    for item in doomed:
        # Deleting an artwork cascades to its versions in the database, so a row
        # later in this list may already be gone by the time we reach it.
        if db.get(Item, item.id) is None:
            continue
        _hard_delete(db, item)
        purged += 1
    return purged
