"""Artwork versions: several files, one artwork, one of them displayed.

The model is intentionally shallow — an artwork is a row with
`version_of_id IS NULL`, and its versions are rows pointing at it. Versions of
versions are collapsed rather than allowed, because a tree buys nothing here
(nobody wants "the third revision of the second scan" as a distinct concept) and
costs cycle checks, recursive queries and a canonical rule that has to pick a
winner across levels.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Item


class VersionError(ValueError):
    """The requested version relationship is not allowed."""


def root_of(db: Session, item: Item) -> Item:
    """The artwork an item belongs to — itself, unless it is a version."""
    if item.version_of_id is None:
        return item
    root = db.get(Item, item.version_of_id)
    return root or item


def versions_of(db: Session, root: Item) -> list[Item]:
    """Every file for this artwork, the artwork's own file first."""
    others = db.scalars(
        select(Item)
        .where(Item.version_of_id == root.id, Item.is_deleted.is_(False))
        .order_by(Item.added_at)
    ).all()
    return [root, *others]


def display_item(db: Session, item: Item) -> Item:
    """The file this artwork should actually show.

    Falls back to the artwork's own file whenever the pointer is missing,
    dangling or points at something deleted — a stale pointer must degrade to
    "show the original" rather than to a broken image.
    """
    if item.canonical_version_id is None:
        return item
    chosen = db.get(Item, item.canonical_version_id)
    if chosen is None or chosen.is_deleted:
        return item
    if chosen.id != item.id and chosen.version_of_id != item.id:
        return item
    return chosen


def set_deleted(db: Session, item: Item, deleted: bool, when) -> int:  # noqa: ANN001
    """Move an artwork's versions to or from the trash along with it.

    Versions are files of the artwork, not independent pictures, so trashing the
    artwork has to take them; leaving them behind would strand rows that no grid
    shows and no trash view offers to restore. Returns how many were touched.
    """
    if item.version_of_id is not None:
        return 0
    affected = db.scalars(select(Item).where(Item.version_of_id == item.id)).all()
    for version in affected:
        version.is_deleted = deleted
        version.deleted_at = when if deleted else None
    return len(affected)


def attach(db: Session, root: Item, version: Item) -> Item:
    """Make `version` a version of `root`."""
    if version.id == root.id:
        raise VersionError("An artwork cannot be a version of itself")
    if root.version_of_id is not None:
        raise VersionError("Attach versions to the artwork itself, not to one of its versions")
    if version.canonical_version_id is not None or db.scalar(
        select(Item.id).where(Item.version_of_id == version.id)
    ):
        # Flattening someone else's version set silently would lose their
        # canonical choice; refusing says so.
        raise VersionError("That item already has versions of its own")

    version.version_of_id = root.id
    # A version is not a card of its own, so anything that pointed at it as a
    # board cover or profile image keeps working through the artwork instead.
    db.commit()
    db.refresh(version)
    return version


def detach(db: Session, version: Item) -> Item:
    """Promote a version back to a standalone artwork."""
    if version.version_of_id is None:
        raise VersionError("That item is not a version")
    root = db.get(Item, version.version_of_id)
    if root is not None and root.canonical_version_id == version.id:
        # The artwork would otherwise keep displaying a file that no longer
        # belongs to it.
        root.canonical_version_id = None
    version.version_of_id = None
    db.commit()
    db.refresh(version)
    return version


def set_canonical(db: Session, root: Item, version_id: int) -> Item:
    """Choose which file the artwork displays."""
    if root.version_of_id is not None:
        raise VersionError("Set the canonical file on the artwork, not on one of its versions")
    if version_id == root.id:
        root.canonical_version_id = None
    else:
        chosen = db.get(Item, version_id)
        if chosen is None or chosen.version_of_id != root.id:
            raise VersionError("That item is not a version of this artwork")
        if chosen.is_deleted:
            raise VersionError("That version is in the trash")
        root.canonical_version_id = chosen.id
    db.commit()
    db.refresh(root)
    return root
