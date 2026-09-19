"""Turning bytes into `items` rows: dedup, near-duplicate reporting, indexing."""

from __future__ import annotations

import errno
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Item
from . import images, search, settings_store

# Hamming distance below which two perceptual hashes are treated as the same
# picture. 8/64 bits is the commonly used threshold for pHash: low enough that
# genuinely different artwork doesn't collide, high enough to catch a re-saved
# or re-compressed copy. Near-duplicates are *reported*, never auto-rejected —
# deciding that two similar images are the same one is the user's call.
PHASH_NEAR_DUPLICATE_DISTANCE = 8


@dataclass(slots=True)
class IngestResult:
    item: Item
    created: bool
    near_duplicate_ids: list[int]


def ingest(
    db: Session,
    data: bytes,
    *,
    title: str | None = None,
    description: str | None = None,
    source_url: str | None = None,
    parent_item_id: int | None = None,
    derivative_target: str | None = None,
    known_hash: str | None = None,
    storage_key: str | None = None,
    replace_item: Item | None = None,
) -> IngestResult:
    hash_hex = known_hash or images.sha256_of(data)

    # A keyed crop (avatar/banner/cover) updates its existing row in place, so
    # re-cropping from the same photo keeps the same item id instead of leaving
    # a trail of abandoned derivatives. Content dedup is skipped for these: two
    # different crops of one photo are legitimately different pictures, and the
    # file they share a name with is being rewritten anyway.
    #
    # A plain keyed upload (routers/links.py's link-cover upload) can plausibly
    # collide with something already in the collection, though -- `items.hash`
    # is globally unique, so a second row can't be inserted for the same bytes
    # regardless. Dedup finds that existing item and hands it back unchanged;
    # the caller's own `replace_item` lookup is what has to make sure a later
    # re-upload never mistakes that borrowed, unrelated item for one of its
    # own keyed covers and overwrites it in place.
    existing = None if replace_item is not None else db.scalar(select(Item).where(Item.hash == hash_hex))
    if existing is not None:
        # Re-uploading a file that is in the trash restores it rather than
        # failing: the user's intent ("I want this in my collection") is
        # unambiguous, and refusing would leave them unable to re-add it without
        # first finding it in Trash.
        if existing.is_deleted:
            existing.is_deleted = False
            existing.deleted_at = None
            db.commit()
        return IngestResult(item=existing, created=False, near_duplicate_ids=[])

    try:
        processed = images.process(
            data,
            convert_png_to_webp=bool(settings_store.get(db, "storage.convert_png_to_webp")),
            preserve_original=bool(settings_store.get(db, "storage.preserve_original_bytes")),
            known_hash=known_hash,
            storage_key=storage_key,
        )
    except OSError as exc:
        # Disk-full (or any other write failure) mid-upload is a real failure
        # mode this app has to handle cleanly rather than surface as an
        # unhandled 500 with a raw traceback (advance.md §8). The atomic write
        # in `images._atomic_write_bytes` has already cleaned up its own temp
        # file by the time this is caught, so there is nothing left on disk to
        # clean up here — just a clear message for the caller.
        if exc.errno == errno.ENOSPC:
            raise images.InvalidImageError(
                "Not enough disk space on the server to save this file"
            ) from exc
        raise images.InvalidImageError(f"Could not write file to disk: {exc.strerror or exc}") from exc

    near = find_near_duplicates(db, processed.phash)

    if replace_item is not None:
        replace_item.hash = processed.sha256
        replace_item.phash = processed.phash
        replace_item.storage_path = processed.storage_path
        replace_item.width = processed.width
        replace_item.height = processed.height
        replace_item.filesize = processed.filesize
        replace_item.mime_type = processed.mime_type
        replace_item.dominant_color = processed.dominant_color
        replace_item.orientation = processed.orientation
        replace_item.derivative_target = derivative_target
        db.commit()
        db.refresh(replace_item)
        search.reindex_item(db, replace_item)
        return IngestResult(item=replace_item, created=False, near_duplicate_ids=near)

    item = Item(
        hash=processed.sha256,
        phash=processed.phash,
        storage_path=processed.storage_path,
        parent_item_id=parent_item_id,
        title=title,
        description=description,
        width=processed.width,
        height=processed.height,
        filesize=processed.filesize,
        mime_type=processed.mime_type,
        source_url=source_url,
        dominant_color=processed.dominant_color,
        orientation=processed.orientation,
        derivative_target=derivative_target,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    search.reindex_item(db, item)
    return IngestResult(item=item, created=True, near_duplicate_ids=near)


def find_near_duplicates(db: Session, phash: str, exclude_id: int | None = None) -> list[int]:
    """Linear scan over stored pHashes.

    Honest about its cost: this is O(n) per ingest. At the single-user scale this
    project targets (tens of thousands of items) that is a few milliseconds of
    integer XOR and not worth a BK-tree index; if a collection ever reaches the
    point where it isn't, this is the function to replace, and nothing else.
    """
    rows = db.execute(
        select(Item.id, Item.phash).where(Item.phash.is_not(None), Item.is_deleted.is_(False))
    ).all()
    out = []
    for item_id, other in rows:
        if item_id == exclude_id:
            continue
        try:
            if images.phash_distance(phash, other) <= PHASH_NEAR_DUPLICATE_DISTANCE:
                out.append(item_id)
        except ValueError:
            continue
    return out
