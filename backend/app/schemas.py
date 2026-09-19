"""Pydantic request/response models."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Orientation = Literal["portrait", "landscape", "square"]
CropTarget = Literal["avatar", "banner", "board_cover"]
SortOrder = Literal["added_at", "dimensions", "filesize", "title"]
MatchMode = Literal["all", "any"]


def _require_http_if_set(v: str | None) -> str | None:
    """Shared by every optional-URL field: empty clears it, anything else must
    look like a URL. Kept as a function rather than a validator mixin because
    `field_validator` cannot easily be inherited across unrelated models."""
    if v is None:
        return None
    clean = v.strip()
    if not clean:
        return None
    if not clean.startswith(("http://", "https://")):
        raise ValueError("link must start with http:// or https://")
    return clean


class TagCategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str
    color: str
    position: int = 0
    links_enabled: bool = False
    #: A default icon for every tag filed under this category — see
    #: `Tag.icon`, which wins over this when a tag sets its own.
    icon: str | None = None


class TagCategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(min_length=4, max_length=7)
    links_enabled: bool = False
    icon: str | None = None


class TagCategoryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    color: str | None = None
    links_enabled: bool | None = None
    #: Distinguished from "omitted" via `model_fields_set` (same as
    #: `TagPatch.link_url`) so clearing the icon back to none is possible.
    icon: str | None = None


class TagOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str
    color: str | None = None
    category: TagCategoryOut | None = None
    #: A single outbound link (creator shop/profile/portfolio). Only shown for
    #: editing in the UI when the tag's category has `links_enabled`, but the
    #: value travels on every tag regardless — see the model docstring.
    link_url: str | None = None
    #: Opts this tag's items out of passive browsing (the Feed) — see the
    #: model docstring and `services/queries.build_query`.
    hide_from_feed: bool = False
    #: This tag's own icon, if it has one. The category's icon is the default
    #: for every tag under it — see `TagCategoryOut.icon` — but the frontend
    #: resolves that fallback (same precedence as `color`); this field is
    #: always the tag's own value, never pre-resolved.
    icon: str | None = None


class TagSuggestion(BaseModel):
    id: int
    name: str
    slug: str
    color: str | None = None
    category: TagCategoryOut | None = None
    link_url: str | None = None
    icon: str | None = None
    usage_count: int = 0


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    color: str | None = None
    category_id: int | None = None
    link_url: str | None = None
    icon: str | None = None

    _validate_link = field_validator("link_url")(_require_http_if_set)


class TagPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    color: str | None = None
    #: `...` (Ellipsis) sentinel would be needed to distinguish "leave as is"
    #: from "clear it" for a nullable field — instead this is always applied
    #: when the request includes the key at all, same as `ItemPatch.tags`;
    #: routers that need "unset" send `category_id: null` explicitly.
    category_id: int | None = None
    clear_category: bool = False
    #: Same "always applied when present" rule as `color`: send `""` to clear.
    link_url: str | None = None
    hide_from_feed: bool | None = None
    #: Distinguished from "omitted" via `model_fields_set`, same as `link_url`
    #: — `null` clears it back to inheriting the category's icon (if any).
    icon: str | None = None

    _validate_link = field_validator("link_url")(_require_http_if_set)


class TagGraphRuleIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    from_category_id: int
    to_category_id: int
    via_category_id: int


class TagGraphRulePatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    from_category_id: int | None = None
    to_category_id: int | None = None
    via_category_id: int | None = None


class TagGraphRuleOut(BaseModel):
    id: int
    #: Always populated — a rule saved with no name gets a composed one
    #: ("Anime ✕ Hinata via Haikyu") so the sidebar never shows a blank row.
    name: str
    from_category: TagCategoryOut
    to_category: TagCategoryOut
    via_category: TagCategoryOut


class ItemUrls(BaseModel):
    thumb: str
    display: str
    download: str


class ItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    hash: str
    phash: str | None
    title: str | None
    description: str | None
    width: int
    height: int
    filesize: int
    mime_type: str
    source_url: str | None
    dominant_color: str | None
    orientation: str
    parent_item_id: int | None
    derivative_target: str | None
    #: Free-text description of how this file differs from the artwork's other
    #: versions ("Grayscale", "Outline") — blank for a plain crop/resize/reformat.
    variant_label: str | None = None
    #: Set when this row is one file of another artwork rather than an artwork.
    version_of_id: int | None = None
    #: Which version this artwork displays; null means its own file.
    canonical_version_id: int | None = None
    #: The item whose pixels `urls` point at — this item, or its canonical version.
    displayed_item_id: int | None = None
    is_deleted: bool
    deleted_at: datetime | None
    added_at: datetime
    updated_at: datetime
    tags: list[TagOut] = []
    urls: ItemUrls


class ItemPage(BaseModel):
    items: list[ItemOut]
    next_cursor: str | None = None
    total: int


class ItemPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    source_url: str | None = None
    variant_label: str | None = None
    tags: list[str] | None = None  # full replacement when present


class UploadResult(BaseModel):
    item: ItemOut
    created: bool
    near_duplicate_ids: list[int] = []


class BulkImportResult(BaseModel):
    created: list[ItemOut] = []
    duplicates: list[ItemOut] = []
    failed: list[dict[str, str]] = []


class BulkAction(BaseModel):
    item_ids: list[int] = Field(min_length=1)
    action: Literal["tag", "untag", "add_to_board", "remove_from_board", "delete", "restore"]
    tags: list[str] | None = None
    board_id: int | None = None


class BulkActionResult(BaseModel):
    affected: int


class VersionList(BaseModel):
    artwork_id: int
    canonical_id: int
    versions: list[ItemOut]


class AttachVersion(BaseModel):
    item_id: int
    make_canonical: bool = False


class SetCanonical(BaseModel):
    version_id: int


class CropRequest(BaseModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    w: int = Field(gt=0)
    h: int = Field(gt=0)
    target: CropTarget | None = None
    board_id: int | None = None  # required when target == "board_cover"
    # The "resize" half of crop/resize. Downscale only; see images.crop_bytes.
    output_width: int | None = Field(default=None, gt=0, le=10000)
    # Freeform crops only: show the crop as the artwork's image. Defaults to true
    # because cropping something and seeing nothing change would read as the
    # crop having failed; the original stays one click away in the versions strip.
    make_canonical: bool = True


class BoardQueryTagIn(BaseModel):
    tag_id: int
    match_mode: MatchMode = "any"


class BoardIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    is_dynamic: bool = False
    cover_item_id: int | None = None
    query_tags: list[BoardQueryTagIn] = []


class BoardPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    cover_item_id: int | None = None
    position: int | None = None
    query_tags: list[BoardQueryTagIn] | None = None


class BoardOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str
    description: str | None
    cover_item_id: int | None
    cover_url: str | None = None
    is_dynamic: bool
    created_at: datetime
    position: int
    item_count: int = 0
    query_tags: list[TagOut] = []
    match_mode: MatchMode = "any"
    subboard_tags: list[TagOut] = []


class BoardItemsIn(BaseModel):
    item_ids: list[int]


class SubboardTagIn(BaseModel):
    is_active: bool


class GraphNode(BaseModel):
    id: int
    name: str
    color: str | None
    category: TagCategoryOut | None = None
    link_url: str | None = None
    hide_from_feed: bool = False
    icon: str | None = None
    usage_count: int


class GraphEdge(BaseModel):
    source: int
    target: int
    weight: int


class TagGraph(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class LinkIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1)
    description: str | None = None
    group_name: str | None = None
    icon: str | None = None
    position: int | None = None

    @field_validator("url")
    @classmethod
    def _require_http(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            raise ValueError("url must start with http:// or https://")
        return v


class LinkPatch(BaseModel):
    title: str | None = None
    url: str | None = None
    description: str | None = None
    group_name: str | None = None
    icon: str | None = None
    position: int | None = None
    cover_item_id: int | None = None


class LinkOut(BaseModel):
    id: int
    title: str
    url: str
    description: str | None
    group_name: str | None
    icon: str | None
    position: int
    cover_item_id: int | None
    # Ready-to-use `/api/items/{id}/file/thumb` URL, resolved by the router
    # the same way `_decorate` resolves the profile avatar/banner in
    # routers/settings.py -- saves the frontend a second round-trip just to
    # turn an item id into an `<img src>`.
    cover_url: str | None = None


class SettingsIn(BaseModel):
    values: dict[str, Any]


class DiscoverResult(BaseModel):
    title: str | None
    image_url: str
    thumbnail_url: str | None
    source_url: str | None
    engine: str | None
    width: int | None = None
    height: int | None = None


class DiscoverResponse(BaseModel):
    query: str
    #: What was actually sent upstream after the query template was applied.
    expanded_query: str = ""
    results: list[DiscoverResult]


class DiscoverSave(BaseModel):
    image_url: str
    source_url: str | None = None
    title: str | None = None
    tags: list[str] = []


class OnThisDayGroup(BaseModel):
    year: int
    items: list[ItemOut]


class PurgeResult(BaseModel):
    purged: int


class IntegrityIssue(BaseModel):
    item_id: int
    storage_path: str
    problem: Literal["missing", "corrupt"]


class IntegrityReport(BaseModel):
    checked: int
    scanned: int
    issues: list[IntegrityIssue] = []


class ReconciliationReport(BaseModel):
    orphaned_files: list[str] = []
    missing_files: list[str] = []


class NearDuplicatePair(BaseModel):
    a: ItemOut
    b: ItemOut
    distance: int


class TagMergeIn(BaseModel):
    into_tag_id: int


class TagMergeResult(BaseModel):
    merged_tag_id: int
    into_tag_id: int
    items_reassigned: int


class CitationEntry(BaseModel):
    item_id: int
    title: str | None
    artist: str | None
    creation_date: str | None
    source: str | None


class CitationExport(BaseModel):
    entries: list[CitationEntry]
    text: str


class ImportResult(BaseModel):
    items_imported: int
    tags_imported: int
    boards_imported: int
    skipped: int
