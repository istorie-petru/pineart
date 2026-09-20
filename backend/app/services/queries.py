"""Item listing: filters, sort orders and cursor pagination."""

from __future__ import annotations

import base64
import json
import secrets
from datetime import datetime
from typing import Any

from sqlalchemy import Select, func, select, tuple_
from sqlalchemy.orm import Session

from ..models import Board, BoardItem, BoardQueryTag, Item, ItemTag, Tag
from . import search
from . import settings_store
from . import tags as tag_service

# `title` is coalesced to '' rather than sorted raw: SQL comparisons against NULL
# evaluate to NULL, which would silently drop every untitled item from the page
# after the first once cursor pagination started comparing against it.
SORT_COLUMNS = {
    "added_at": (Item.added_at, "desc"),
    "dimensions": (Item.width * Item.height, "desc"),
    "filesize": (Item.filesize, "desc"),
    "title": (func.coalesce(Item.title, ""), "asc"),
}

# "random" isn't a real column, so it can't live in SORT_COLUMNS -- it's a
# synthetic rank computed per row from a per-shuffle seed (see `paginate`'s
# random branch). `RANDOM()` has no seed in SQLite, so `ORDER BY RANDOM()`
# reshuffles on every single call; two consecutive pages would each draw an
# independent shuffle of the *whole* filtered set, which reads as duplicates
# and gaps rather than one continuous feed. A seeded, deterministic formula
# instead gives a stable-per-seed ordering that pages exactly like any other
# sort -- the seed just rides along in the cursor.
_RANDOM_MODULUS = 2_147_483_647  # a Mersenne prime; keeps the arithmetic in range
# This has to be a *large* fraction of the modulus, not just any multiplier
# coprime to it. `rank(id) = id * multiplier + seed (mod modulus)` is a
# straight line in `id` with slope `multiplier`, and that line only wraps
# around the modulus -- which is the only thing that actually scrambles the
# order -- once accumulated distance exceeds the modulus. With a "well-known"
# small multiplier like 48271 (a Lehmer/Park-Miller *iteration* constant,
# meant for repeatedly re-multiplying a running state, not for hashing a
# small key directly) that took roughly modulus / 48271 ≈ 44,478 consecutive
# ids before the first wrap. Below that, `rank` is monotonic in `id` in
# practice for any real collection, for *any* seed — a constant additive
# `seed` shifts every rank by the same amount without touching their
# relative order, so every reload looked identical, and because items tagged
# together are typically uploaded as a same-id batch, the untouched id order
# read as "grouped by tag". A multiplier near the golden-ratio fraction of
# the modulus (~0.618 · modulus — the standard choice for scattering
# consecutive small integers, aka Fibonacci hashing) wraps on nearly every
# single step instead, so the id ordering doesn't survive at all.
_RANDOM_MULTIPLIER = 1_327_217_871


def _random_rank(item_id: int, seed: int) -> int:
    return (item_id * _RANDOM_MULTIPLIER + seed) % _RANDOM_MODULUS


class InvalidCursor(ValueError):
    """The cursor is malformed, or was issued for a different ordering."""


def encode_cursor(value: Any, item_id: int, key: str, seed: int | None = None) -> str:
    """Encode a cursor that carries the ordering it belongs to.

    `key` is what makes this safe. The previous version stored only the value and
    the id, and the reader re-derived how to interpret them from the surrounding
    request — which went wrong exactly once and silently: an `added_at` cursor
    was parsed back into a datetime only when no board was involved, so on a
    dynamic board SQLite ended up comparing the ISO string "2026-07-26T12:00:00"
    against a column stored as "2026-07-26 12:00:00". 'T' sorts after ' ', the
    comparison matched nothing, and every page returned the first page again —
    the same handful of images repeating forever.

    With the ordering named in the cursor, decoding cannot disagree with the
    ORDER BY, because it is no longer inferring anything.
    """
    if isinstance(value, datetime):
        value = value.isoformat()
    payload: dict[str, Any] = {"v": value, "id": item_id, "k": key}
    if seed is not None:
        payload["s"] = seed
    raw = json.dumps(payload).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str, expected_key: str) -> tuple[Any, int, int | None]:
    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(padded.encode()))
        value, item_id, key = data["v"], int(data["id"]), data["k"]
        seed = data.get("s")
    except (ValueError, KeyError, TypeError) as exc:
        raise InvalidCursor("Malformed pagination cursor") from exc

    if key != expected_key:
        # Reusing a cursor across a sort change would interleave two orderings
        # and duplicate rows. Failing loudly beats returning plausible nonsense.
        raise InvalidCursor(
            f"This cursor belongs to a different ordering ({key}, not {expected_key})"
        )
    if key == "added_at" and isinstance(value, str):
        value = datetime.fromisoformat(value)
    return value, item_id, (int(seed) if seed is not None else None)


def dynamic_board_item_ids(db: Session, board: Board) -> Select:
    """Subquery of item ids belonging to a saved-search board.

    Membership is computed at read time from `board_query_tags`, never written to
    `board_items` — that is what keeps a dynamic board current as items are
    tagged and untagged, with no reconciliation job.
    """
    rows = db.execute(
        select(BoardQueryTag.tag_id, BoardQueryTag.match_mode).where(
            BoardQueryTag.board_id == board.id
        )
    ).all()
    tag_ids = [r[0] for r in rows]
    match_mode = rows[0][1] if rows else "any"
    if not tag_ids:
        # A dynamic board with no query tags matches nothing. The alternative
        # (matching everything) would make an unfinished board look like a
        # duplicate of the whole collection.
        return select(Item.id).where(Item.id.is_(None))

    stmt = select(ItemTag.item_id).where(ItemTag.tag_id.in_(tag_ids))
    if match_mode == "all":
        stmt = stmt.group_by(ItemTag.item_id).having(
            func.count(func.distinct(ItemTag.tag_id)) == len(tag_ids)
        )
    return stmt


def build_query(
    db: Session,
    *,
    parsed: search.ParsedQuery,
    board: Board | None = None,
    subboard_tag_ids: list[int] | None = None,
    include_deleted: bool = False,
    only_deleted: bool = False,
    untagged_only: bool = False,
) -> Select:
    stmt = select(Item)

    if only_deleted:
        stmt = stmt.where(Item.is_deleted.is_(True))
    elif not include_deleted:
        stmt = stmt.where(Item.is_deleted.is_(False))

    # Neither alternate files nor profile assets are cards of their own.
    #
    # A set of scans of one picture should read as one artwork rather than a row
    # of near-duplicates, and cropping something to use as an avatar should not
    # deposit a second, oddly-shaped copy of it in the collection. Both were
    # visible in the feed before and both were wrong for the same reason: they
    # are files belonging to an artwork, not artworks.
    #
    # Trash is the exception — a deleted version has to be findable to restore.
    if not only_deleted:
        stmt = stmt.where(Item.version_of_id.is_(None), Item.derivative_target.is_(None))

    for tag_name in parsed.tags:
        # One EXISTS per tag: this is what makes multiple `tag:` tokens mean AND.
        # A single IN (...) would mean OR and quietly widen every multi-tag query.
        #
        # Matched on slug *or* display name, so `tag:shoyo-hinata` and
        # `tag:"Shōyō Hinata"` both find the same items — the point of keeping a
        # normalized handle alongside the name the user typed.
        exists_stmt = (
            select(ItemTag.item_id)
            .join(Tag, Tag.id == ItemTag.tag_id)
            .where(ItemTag.item_id == Item.id)
            .where(
                (Tag.slug == tag_service.slugify(tag_name))
                | (func.lower(Tag.name) == tag_name.lower())
            )
        )
        stmt = stmt.where(exists_stmt.exists())

    for tag_name in parsed.exclude_tags:
        # NOT EXISTS rather than NOT IN: NOT IN against a subquery that can yield
        # NULL silently returns nothing at all in SQL, which would look like the
        # exclusion having eaten the whole collection.
        excluded = (
            select(ItemTag.item_id)
            .join(Tag, Tag.id == ItemTag.tag_id)
            .where(ItemTag.item_id == Item.id)
            .where(
                (Tag.slug == tag_service.slugify(tag_name))
                | (func.lower(Tag.name) == tag_name.lower())
            )
        )
        stmt = stmt.where(~excluded.exists())

    if parsed.orientations:
        stmt = stmt.where(Item.orientation.in_(parsed.orientations))
    if parsed.exclude_orientations:
        stmt = stmt.where(Item.orientation.not_in(parsed.exclude_orientations))

    if parsed.colors:
        matches = search.matching_dominant_colors(db, parsed.colors)
        if not matches:
            return stmt.where(Item.id.is_(None))
        stmt = stmt.where(Item.dominant_color.in_(matches))

    if parsed.exclude_colors:
        matches = search.matching_dominant_colors(db, parsed.exclude_colors)
        if matches:
            # An item with no dominant colour recorded cannot be "that colour",
            # so it survives the exclusion — hence the explicit NULL branch.
            stmt = stmt.where(
                Item.dominant_color.is_(None) | Item.dominant_color.not_in(matches)
            )

    if "untagged" in parsed.flags:
        stmt = stmt.where(~select(ItemTag.item_id).where(ItemTag.item_id == Item.id).exists())
    if "tagged" in parsed.flags:
        stmt = stmt.where(select(ItemTag.item_id).where(ItemTag.item_id == Item.id).exists())
    if "untitled" in parsed.flags:
        stmt = stmt.where((Item.title.is_(None)) | (func.trim(Item.title) == ""))
    if "titled" in parsed.flags:
        stmt = stmt.where(Item.title.is_not(None), func.trim(Item.title) != "")

    if parsed.text:
        ids = search.fts_match_ids(db, parsed.text)
        if not ids:
            return stmt.where(Item.id.is_(None))
        stmt = stmt.where(Item.id.in_(ids))

    if untagged_only:
        stmt = stmt.where(~select(ItemTag.item_id).where(ItemTag.item_id == Item.id).exists())

    # NSFW mode (Settings → Collection → "Switch to NSFW mode"): a tag marked
    # `Tag.nsfw` opts its items out of ordinary browsing by default — the
    # Feed *and* any board, not just passive browsing with no board of its
    # own — unless the mode is switched on, in which case browsing shows
    # *only* NSFW-tagged items instead of excluding them. Either way, a
    # search that names the tag explicitly still finds it: asking for it by
    # name is exactly how you'd go looking for something the ambient default
    # keeps out of view. Trash is excluded from this entirely; it is a
    # maintenance view, not browsing. Untagged items never carry an NSFW tag,
    # so they pass through both branches unaffected.
    if not only_deleted:
        requested = {name.lower() for name in parsed.tags}
        nsfw_tag_ids = [
            nsfw_tag.id
            for nsfw_tag in db.scalars(select(Tag).where(Tag.nsfw.is_(True))).all()
            if nsfw_tag.slug.lower() not in requested and nsfw_tag.name.lower() not in requested
        ]
        if nsfw_tag_ids:
            nsfw_exists = select(ItemTag.item_id).where(
                ItemTag.item_id == Item.id, ItemTag.tag_id.in_(nsfw_tag_ids)
            )
            if bool(settings_store.get(db, "collection.nsfw_mode")):
                stmt = stmt.where(nsfw_exists.exists())
            else:
                stmt = stmt.where(~nsfw_exists.exists())

    if board is not None:
        if board.is_dynamic:
            stmt = stmt.where(Item.id.in_(dynamic_board_item_ids(db, board)))
        else:
            stmt = stmt.where(
                Item.id.in_(select(BoardItem.item_id).where(BoardItem.board_id == board.id))
            )

    if subboard_tag_ids:
        stmt = stmt.where(
            Item.id.in_(select(ItemTag.item_id).where(ItemTag.tag_id.in_(subboard_tag_ids)))
        )

    return stmt


def paginate(
    db: Session,
    stmt: Select,
    *,
    sort: str = "added_at",
    limit: int = 40,
    cursor: str | None = None,
    board: Board | None = None,
) -> tuple[list[Item], str | None, int]:
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    seed: int | None = None

    # A manual board's whole point is its arrangement, so board_items.position
    # overrides the global sort when one is in play.
    if board is not None and not board.is_dynamic:
        stmt = stmt.join(BoardItem, BoardItem.item_id == Item.id).where(
            BoardItem.board_id == board.id
        )
        order_col, direction = BoardItem.position, "asc"
        order_key = "position"
    elif sort == "random":
        order_key = "random"
        direction = "asc"
        # The seed rides in on the cursor once there is one; the very first
        # page (no cursor yet) mints a fresh one. Reusing the seed for every
        # later page is what turns "load more" from a reshuffle-and-hope into
        # an actual continuation of the same shuffle.
        if cursor:
            _, _, seed = decode_cursor(cursor, order_key)
        if seed is None:
            seed = secrets.randbelow(_RANDOM_MODULUS)
        order_col = (Item.id * _RANDOM_MULTIPLIER + seed) % _RANDOM_MODULUS
    else:
        order_key = sort if sort in SORT_COLUMNS else "added_at"
        order_col, direction = SORT_COLUMNS[order_key]

    if cursor:
        value, last_id, _ = decode_cursor(cursor, order_key)
        row = tuple_(order_col, Item.id)
        stmt = stmt.where(row < tuple_(value, last_id) if direction == "desc" else row > tuple_(value, last_id))

    if direction == "desc":
        stmt = stmt.order_by(order_col.desc(), Item.id.desc())
    else:
        stmt = stmt.order_by(order_col.asc(), Item.id.asc())

    items = list(db.scalars(stmt.limit(limit + 1)).all())
    next_cursor = None
    if len(items) > limit:
        items = items[:limit]
        last = items[-1]
        if order_key == "position":
            position = db.scalar(
                select(BoardItem.position).where(
                    BoardItem.board_id == board.id, BoardItem.item_id == last.id
                )
            )
            next_cursor = encode_cursor(position, last.id, order_key)
        elif order_key == "random":
            assert seed is not None
            next_cursor = encode_cursor(_random_rank(last.id, seed), last.id, order_key, seed=seed)
        else:
            next_cursor = encode_cursor(_sort_value(last, order_key), last.id, order_key)
    return items, next_cursor, total


def _sort_value(item: Item, sort: str) -> Any:
    if sort == "dimensions":
        return item.width * item.height
    if sort == "filesize":
        return item.filesize
    if sort == "title":
        return item.title or ""
    return item.added_at
