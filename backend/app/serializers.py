"""Model -> response conversion.

Kept out of the routers so that the URL scheme for images is defined exactly
once: every place an item is returned uses the same thumb/display/download
triple, and changing the route prefix is a one-line change here.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session, object_session

from .models import Board, BoardQueryTag, BoardSubboardTag, Item, Tag
from .schemas import BoardOut, ItemOut, ItemUrls, TagOut


def item_urls(item: Item) -> ItemUrls:
    return ItemUrls(
        thumb=f"/api/items/{item.id}/file/thumb",
        display=f"/api/items/{item.id}/file/display",
        download=f"/api/items/{item.id}/download",
    )


def _displayed(item: Item) -> Item:
    """Resolve which file an artwork shows, without needing a session passed in.

    The session is taken from the instance itself so every existing call site
    keeps working unchanged; a detached instance simply shows its own file. A
    dangling or deleted pointer also falls back to the artwork's own file, so a
    stale canonical choice degrades to the original rather than to a broken
    image.
    """
    if item.canonical_version_id is None:
        return item
    session = object_session(item)
    if session is None:
        return item
    chosen = session.get(Item, item.canonical_version_id)
    if chosen is None or chosen.is_deleted or chosen.version_of_id != item.id:
        return item
    return chosen


def item_out(item: Item, display: Item | None = None) -> ItemOut:
    """Serialize an item, showing the canonical version's pixels when one is set.

    An artwork with a chosen canonical version keeps its own id, title, tags and
    board memberships — only the image URLs and the file-level metadata come from
    the file being displayed. That separation is the point: switching which scan
    is shown must not move the artwork in the grid or detach it from its boards.
    """
    shown = display or _displayed(item)
    return ItemOut(
        id=item.id,
        hash=item.hash,
        phash=item.phash,
        title=item.title,
        description=item.description,
        width=shown.width,
        height=shown.height,
        filesize=shown.filesize,
        mime_type=shown.mime_type,
        source_url=item.source_url,
        dominant_color=shown.dominant_color,
        orientation=shown.orientation,
        parent_item_id=item.parent_item_id,
        derivative_target=item.derivative_target,
        variant_label=item.variant_label,
        version_of_id=item.version_of_id,
        canonical_version_id=item.canonical_version_id,
        displayed_item_id=shown.id,
        is_deleted=item.is_deleted,
        deleted_at=item.deleted_at,
        added_at=item.added_at,
        updated_at=item.updated_at,
        tags=[TagOut.model_validate(t) for t in item.tags],
        urls=item_urls(shown),
    )


def board_out(db: Session, board: Board) -> BoardOut:
    # Local import: queries (and search, for the empty ParsedQuery below)
    # import models, not this module.
    from .services import queries, search

    # Routed through `build_query` (rather than a bespoke count query per
    # board kind) so this count always matches what the board's own item
    # listing actually shows — deleted items excluded and NSFW-tagged items
    # filtered per Settings → Collection → "Switch to NSFW mode", the same as
    # every other item listing.
    count = (
        db.scalar(
            select(func.count()).select_from(
                queries.build_query(db, parsed=search.ParsedQuery(), board=board).subquery()
            )
        )
        or 0
    )

    if board.is_dynamic:
        rows = db.execute(
            select(Tag, BoardQueryTag.match_mode)
            .join(BoardQueryTag, BoardQueryTag.tag_id == Tag.id)
            .where(BoardQueryTag.board_id == board.id)
        ).all()
        query_tags = [TagOut.model_validate(r[0]) for r in rows]
        match_mode = rows[0][1] if rows else "any"
    else:
        query_tags = []
        match_mode = "any"

    subboards = db.scalars(
        select(Tag)
        .join(BoardSubboardTag, BoardSubboardTag.tag_id == Tag.id)
        .where(BoardSubboardTag.board_id == board.id, BoardSubboardTag.is_active.is_(True))
    ).all()

    return BoardOut(
        id=board.id,
        name=board.name,
        slug=board.slug,
        description=board.description,
        cover_item_id=board.cover_item_id,
        # /file/hero, not /file/display (2026-09-18) -- a board cover crop
        # gets the same higher quality/size hero derivative as the profile
        # avatar/banner (images.py's HERO_TARGET_SUFFIXES), for the same
        # reason: one cover per board, not thousands of grid items.
        cover_url=(
            f"/api/items/{board.cover_item_id}/file/hero" if board.cover_item_id else None
        ),
        is_dynamic=board.is_dynamic,
        created_at=board.created_at,
        position=board.position,
        item_count=count,
        query_tags=query_tags,
        match_mode=match_mode,
        subboard_tags=[TagOut.model_validate(t) for t in subboards],
    )
