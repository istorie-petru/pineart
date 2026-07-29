"""SQLAlchemy models — architecture §2 / §2a.

Index choices are not incidental: every one of them backs a query the app runs on
every page load (feed ordering, dedup lookup, tag co-occurrence join, board order).
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Item(Base):
    __tablename__ = "items"

    id: Mapped[int] = mapped_column(primary_key=True)
    hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    phash: Mapped[str | None] = mapped_column(String(32), nullable=True)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    parent_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("items.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    filesize: Mapped[int] = mapped_column(Integer, nullable=False)
    mime_type: Mapped[str] = mapped_column(String(64), nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    dominant_color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    orientation: Mapped[str] = mapped_column(String(9), nullable=False)
    derivative_target: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # A free-text name for *this file* within its artwork's version set —
    # "Grayscale", "Outline", "V2 scan" — so versions that are not simply a
    # crop or resize can say in what way they differ. Left blank for the common
    # case (just a crop/resize/reformat), where dimensions and file size in the
    # versions strip already say enough. Distinct from `derivative_target`,
    # which is a system-assigned *role* (this file is currently the banner),
    # not a description — a version can carry both, e.g. a grayscale crop that
    # also happens to be the current avatar.
    variant_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Versions of one artwork: alternate files of the same picture (a better
    # scan, a higher resolution export, a revised edit). `version_of_id` points
    # at the artwork this file is a version *of*; only rows where it is NULL
    # appear in grids, so a set of versions reads as one artwork rather than as
    # near-duplicates cluttering the collection.
    version_of_id: Mapped[int | None] = mapped_column(
        ForeignKey("items.id", ondelete="CASCADE"), nullable=True
    )
    # Which file this artwork actually displays. NULL means "the artwork's own
    # file"; otherwise it points at one of its versions. Kept as a pointer rather
    # than an `is_canonical` flag on each version, because a pointer cannot end
    # up with two winners or none.
    canonical_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("items.id", ondelete="SET NULL"), nullable=True
    )
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    added_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    tags: Mapped[list["Tag"]] = relationship(
        secondary="item_tags", back_populates="items", lazy="selectin"
    )

    __table_args__ = (
        Index("ix_items_added_at_is_deleted", "added_at", "is_deleted"),
        Index("ix_items_hash", "hash"),
        Index("ix_items_phash", "phash"),
        Index("ix_items_parent_item_id", "parent_item_id"),
        Index("ix_items_version_of_id", "version_of_id"),
    )


class TagCategory(Base):
    """A supercategory tags can be filed under (Character, Show, Media type, …).

    Deliberately flat, one level: tags need a way to be grouped and coloured
    consistently, not a taxonomy. `color` is required (unlike `Tag.color`)
    because a category exists specifically to hand out a colour to the tags
    under it — an uncoloured category would defeat the point of having one.
    """

    __tablename__ = "tag_categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    slug: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    color: Mapped[str] = mapped_column(String(7), nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Not every supercategory means something outside the collection — "Media
    # type" has no external page, but "Creator" does. This is a property of the
    # category, not of each tag, so a Creator category never needs its tags
    # individually opted in one at a time.
    links_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    tags: Mapped[list["Tag"]] = relationship(back_populates="category")

    __table_args__ = (Index("ix_tag_categories_slug", "slug"),)


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    slug: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    # A tag's own colour, when set explicitly, always wins over its category's
    # colour — see architecture note on `TagCategory` above. Left unset, the
    # category supplies the colour, so recolouring a category recolours every
    # tag under it without touching a single `tags` row.
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("tag_categories.id", ondelete="SET NULL"), nullable=True
    )
    # A single outbound link — a creator's shop, social profile, portfolio.
    # "One is enough" by design: this is a pointer to *where this thing is
    # from*, not a social-links block, so it stays one field rather than a
    # collection to manage. Only surfaced in the UI for tags whose category has
    # `links_enabled`, but not enforced here — clearing a tag's category should
    # not have to silently destroy a URL someone typed in.
    link_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    items: Mapped[list[Item]] = relationship(secondary="item_tags", back_populates="tags")
    category: Mapped["TagCategory | None"] = relationship(back_populates="tags", lazy="joined")

    __table_args__ = (
        Index("ix_tags_slug", "slug"),
        Index("ix_tags_category_id", "category_id"),
    )


class ItemTag(Base):
    __tablename__ = "item_tags"

    item_id: Mapped[int] = mapped_column(
        ForeignKey("items.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[int] = mapped_column(
        ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True
    )

    __table_args__ = (
        Index("ix_item_tags_tag_id", "tag_id"),
        Index("ix_item_tags_item_id", "item_id"),
    )


class TagGraphRule(Base):
    """Suppresses a *computed* co-occurrence edge between two categories when a
    more specific relationship already explains it.

    Example: a pin carries Category=Anime, Show=Haikyu, Character=Hinata. Raw
    co-occurrence would draw all three edges, but Anime–Hinata is redundant —
    it only exists because Hinata is in Haikyu, which is Anime. A rule with
    from_category=Anime, to_category=Character, via_category=Show says: drop
    the edge between an Anime tag and a Character tag whenever that Character
    tag also has an edge to a Show tag.

    All three legs cascade: a rule that names a category is only meaningful
    while that category exists, so deleting any one of the three categories
    deletes the rule rather than leaving a dangling, silently-inert row.
    """

    __tablename__ = "tag_graph_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Optional — a rule with no name displays a composed one ("Anime ✕ Hinata
    # via Haikyu") instead of forcing a name on someone who just wants the
    # behavior. Naming it is only useful once there's more than one or two.
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    from_category_id: Mapped[int] = mapped_column(
        ForeignKey("tag_categories.id", ondelete="CASCADE"), nullable=False
    )
    to_category_id: Mapped[int] = mapped_column(
        ForeignKey("tag_categories.id", ondelete="CASCADE"), nullable=False
    )
    via_category_id: Mapped[int] = mapped_column(
        ForeignKey("tag_categories.id", ondelete="CASCADE"), nullable=False
    )

    __table_args__ = (
        UniqueConstraint(
            "from_category_id", "to_category_id", "via_category_id", name="uq_tag_graph_rule"
        ),
    )


class Board(Base):
    __tablename__ = "boards"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    cover_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("items.id", ondelete="SET NULL"), nullable=True
    )
    is_dynamic: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class BoardItem(Base):
    __tablename__ = "board_items"

    board_id: Mapped[int] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), primary_key=True
    )
    item_id: Mapped[int] = mapped_column(
        ForeignKey("items.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    __table_args__ = (Index("ix_board_items_board_id_position", "board_id", "position"),)


class BoardQueryTag(Base):
    """Only meaningful when boards.is_dynamic — membership is computed from these."""

    __tablename__ = "board_query_tags"

    board_id: Mapped[int] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[int] = mapped_column(
        ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True
    )
    match_mode: Mapped[str] = mapped_column(String(3), default="any", nullable=False)


class BoardSubboardTag(Base):
    __tablename__ = "board_subboard_tags"

    board_id: Mapped[int] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[int] = mapped_column(
        ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Link(Base):
    __tablename__ = "link_directory"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str | None] = mapped_column(Text, nullable=True)
    icon: Mapped[str | None] = mapped_column(String(32), nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)  # JSON-encoded


class Session(Base):
    """A logged-in browser session.

    Only the SHA-256 of the session token is stored, so a stolen database backup
    does not contain usable credentials.
    """

    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    __table_args__ = (Index("ix_sessions_token_hash", "token_hash"),)
