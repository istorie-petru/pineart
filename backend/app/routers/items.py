"""Item endpoints — architecture §5."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_config
from ..db import get_db
from ..models import Board, BoardItem, Item
from ..schemas import (
    AttachVersion,
    BulkAction,
    BulkActionResult,
    BulkImportResult,
    CitationExport,
    CropRequest,
    ItemOut,
    ItemPage,
    ItemPatch,
    OnThisDayGroup,
    SetCanonical,
    UploadResult,
    VersionList,
)
from ..serializers import item_out
from ..services import (
    citation,
    images,
    ingest,
    queries,
    search,
    settings_store,
    tags as tag_service,
    versions,
)

router = APIRouter(prefix="/api/items", tags=["items"])

# Aspect ratios the crop endpoint enforces server-side. The client locks the same
# ratios in its UI, but the server re-checks: a client-only constraint is a
# suggestion, and a wrong-aspect avatar would render incorrectly forever.
TARGET_ASPECTS = {"avatar": 1.0, "banner": 3.2, "board_cover": 1.5}
ASPECT_TOLERANCE = 0.08


def _get_item(db: Session, item_id: int) -> Item:
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@router.get("", response_model=ItemPage)
def list_items(
    db: Session = Depends(get_db),
    q: str | None = Query(default=None, description="Search bar string: free text + tag:/color:/orientation: tokens"),
    tag: list[str] | None = Query(default=None),
    color: list[str] | None = Query(default=None),
    orientation: list[str] | None = Query(default=None),
    board: int | None = None,
    subboard_tag: list[int] | None = Query(default=None),
    sort: str | None = None,
    cursor: str | None = None,
    limit: int | None = None,
    random: bool = False,
) -> ItemPage:
    parsed = search.parse(q)
    # Explicit query params are additive with the search-bar tokens, so the
    # frontend can use whichever is more convenient without them fighting.
    parsed.tags.extend(t.lower() for t in (tag or []))
    parsed.orientations.extend(o for o in (orientation or []) if o in search.VALID_ORIENTATIONS)
    for c in color or []:
        normalized = search.normalize_color_token(c)
        if normalized:
            parsed.colors.append(normalized)

    board_obj = db.get(Board, board) if board else None
    if board and board_obj is None:
        raise HTTPException(status_code=404, detail="Board not found")

    stmt = queries.build_query(
        db, parsed=parsed, board=board_obj, subboard_tag_ids=subboard_tag or None
    )

    page_size = limit or int(settings_store.get(db, "collection.page_size"))
    page_size = max(1, min(page_size, 200))

    # "Surprise me" / Feed's default: a seeded shuffle rather than a bare
    # `ORDER BY RANDOM()` one-shot, so it pages and infinite-scrolls exactly
    # like every other sort instead of stopping dead after the first batch —
    # see queries.paginate's random branch for how the seed keeps the shuffle
    # stable across pages.
    sort_key = "random" if random else (sort or str(settings_store.get(db, "collection.default_sort")))
    items, next_cursor, total = queries.paginate(
        db, stmt, sort=sort_key, limit=page_size, cursor=cursor, board=board_obj
    )
    return ItemPage(items=[item_out(i) for i in items], next_cursor=next_cursor, total=total)


@router.get("/untagged", response_model=ItemPage)
def untagged(
    db: Session = Depends(get_db),
    cursor: str | None = None,
    limit: int | None = None,
) -> ItemPage:
    stmt = queries.build_query(db, parsed=search.ParsedQuery(), untagged_only=True)
    page_size = limit or int(settings_store.get(db, "collection.page_size"))
    items, next_cursor, total = queries.paginate(db, stmt, limit=page_size, cursor=cursor)
    return ItemPage(items=[item_out(i) for i in items], next_cursor=next_cursor, total=total)


@router.get("/on-this-day", response_model=list[OnThisDayGroup])
def on_this_day(db: Session = Depends(get_db)) -> list[OnThisDayGroup]:
    """Items added on today's month/day in any previous year (architecture §3a)."""
    rows = db.scalars(
        select(Item)
        .where(
            Item.is_deleted.is_(False),
            func.strftime("%m-%d", Item.added_at) == func.strftime("%m-%d", "now"),
            func.strftime("%Y", Item.added_at) != func.strftime("%Y", "now"),
        )
        .order_by(Item.added_at.desc())
    ).all()
    grouped: dict[int, list[Item]] = {}
    for item in rows:
        grouped.setdefault(item.added_at.year, []).append(item)
    return [
        OnThisDayGroup(year=year, items=[item_out(i) for i in items])
        for year, items in sorted(grouped.items(), reverse=True)
    ]


@router.get("/{item_id}", response_model=ItemOut)
def get_item(item_id: int, db: Session = Depends(get_db)) -> ItemOut:
    return item_out(_get_item(db, item_id))


@router.get("/{item_id}/versions", response_model=VersionList)
def list_versions(item_id: int, db: Session = Depends(get_db)) -> VersionList:
    """Every file for this artwork, with the displayed one marked."""
    item = _get_item(db, item_id)
    root = versions.root_of(db, item)
    files = versions.versions_of(db, root)
    shown = versions.display_item(db, root)
    return VersionList(
        artwork_id=root.id,
        canonical_id=shown.id,
        versions=[item_out(file, display=file) for file in files],
    )


@router.post("/{item_id}/versions", response_model=VersionList, status_code=201)
async def add_version(
    item_id: int,
    file: UploadFile = File(...),
    make_canonical: bool = Form(default=False),
    db: Session = Depends(get_db),
) -> VersionList:
    """Upload another file for this artwork.

    Uploading through this route rather than as an ordinary item is what keeps a
    better scan from appearing in the grid as a second, nearly identical card.
    """
    root = versions.root_of(db, _get_item(db, item_id))
    data = await file.read()
    try:
        result = ingest.ingest(db, data)
    except images.InvalidImageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if result.item.id == root.id:
        raise HTTPException(status_code=400, detail="That file is already this artwork")
    try:
        versions.attach(db, root, result.item)
        if make_canonical:
            versions.set_canonical(db, root, result.item.id)
    except versions.VersionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return list_versions(root.id, db)


@router.post("/{item_id}/versions/attach", response_model=VersionList)
def attach_version(item_id: int, payload: AttachVersion, db: Session = Depends(get_db)) -> VersionList:
    """Fold an item that is already in the collection into this artwork."""
    root = versions.root_of(db, _get_item(db, item_id))
    other = _get_item(db, payload.item_id)
    try:
        versions.attach(db, root, other)
        if payload.make_canonical:
            versions.set_canonical(db, root, other.id)
    except versions.VersionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return list_versions(root.id, db)


@router.post("/{item_id}/versions/detach", response_model=ItemOut)
def detach_version(item_id: int, db: Session = Depends(get_db)) -> ItemOut:
    """Promote a version back to an artwork of its own."""
    item = _get_item(db, item_id)
    try:
        promoted = versions.detach(db, item)
    except versions.VersionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return item_out(promoted)


@router.put("/{item_id}/canonical", response_model=VersionList)
def set_canonical(item_id: int, payload: SetCanonical, db: Session = Depends(get_db)) -> VersionList:
    """Choose which file this artwork displays everywhere."""
    root = versions.root_of(db, _get_item(db, item_id))
    try:
        versions.set_canonical(db, root, payload.version_id)
    except versions.VersionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return list_versions(root.id, db)


@router.get("/{item_id}/citation", response_model=CitationExport)
def item_citation(item_id: int, db: Session = Depends(get_db)) -> CitationExport:
    """Structured citation data for a single item — title, artist tag, added
    date, source URL — as both a machine-readable list and ready-to-paste text."""
    return citation.export_for([_get_item(db, item_id)])


@router.get("/{item_id}/recommendations", response_model=list[ItemOut])
def recommendations(item_id: int, limit: int = 12, db: Session = Depends(get_db)) -> list[ItemOut]:
    item = _get_item(db, item_id)
    return [item_out(i) for i in tag_service.recommendations(db, item, limit=limit)]


@router.post("", response_model=UploadResult, status_code=201)
async def create_item(
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    description: str | None = Form(default=None),
    source_url: str | None = Form(default=None),
    tags: str | None = Form(default=None, description="Comma-separated tag names"),
    db: Session = Depends(get_db),
) -> UploadResult:
    data = await file.read()
    try:
        result = ingest.ingest(
            db, data, title=title, description=description, source_url=source_url
        )
    except images.InvalidImageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if tags:
        names = [t.strip() for t in tags.split(",") if t.strip()]
        tag_service.add_item_tags(db, result.item, names)
        db.commit()
        search.reindex_item(db, result.item)

    return UploadResult(
        item=item_out(result.item),
        created=result.created,
        near_duplicate_ids=result.near_duplicate_ids,
    )


@router.post("/bulk-import", response_model=BulkImportResult)
async def bulk_import(
    files: list[UploadFile] = File(...),
    tags: str | None = Form(default=None, description="Comma-separated tag names"),
    board_id: int | None = Form(default=None),
    db: Session = Depends(get_db),
) -> BulkImportResult:
    """Many files in one request — the local-folder import flow (architecture §2a).

    Per-file failures are reported, not fatal: importing a folder of 400 images
    should not be aborted by one corrupt file.

    Tags and a board can be applied in the same call. Doing it here rather than
    as follow-up requests from the browser matters: uploading and then failing to
    tag would leave a pile of untagged images with no indication which ones were
    meant to carry the labels.
    """
    board = None
    if board_id is not None:
        board = db.get(Board, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="Board not found")
        if board.is_dynamic:
            raise HTTPException(
                status_code=400,
                detail="Dynamic boards compute their membership; tag the images instead",
            )

    tag_names = [name.strip() for name in (tags or "").split(",") if name.strip()]

    failures: list[dict[str, str]] = []
    created: list[Item] = []
    duplicates: list[Item] = []

    for upload in files:
        data = await upload.read()
        try:
            result = ingest.ingest(db, data)
        except images.InvalidImageError as exc:
            failures.append({"filename": upload.filename or "?", "error": str(exc)})
            continue
        (created if result.created else duplicates).append(result.item)

    touched = created + duplicates

    # Applied to duplicates as well as new items: re-adding a picture you already
    # have, with tags, plainly means "this one should carry these tags too".
    if tag_names and touched:
        for item in touched:
            tag_service.add_item_tags(db, item, tag_names)
        db.commit()
        for item in touched:
            search.reindex_item(db, item)

    if board is not None and touched:
        next_position = (
            db.scalar(
                select(func.coalesce(func.max(BoardItem.position), -1)).where(
                    BoardItem.board_id == board.id
                )
            )
            or -1
        ) + 1
        for item in touched:
            if db.get(BoardItem, (board.id, item.id)) is None:
                db.add(BoardItem(board_id=board.id, item_id=item.id, position=next_position))
                next_position += 1
        db.commit()

    # Serialized only now, so the response carries the tags just applied rather
    # than a snapshot from before they existed.
    return BulkImportResult(
        created=[item_out(item) for item in created],
        duplicates=[item_out(item) for item in duplicates],
        failed=failures,
    )


@router.patch("/{item_id}", response_model=ItemOut)
def patch_item(item_id: int, payload: ItemPatch, db: Session = Depends(get_db)) -> ItemOut:
    item = _get_item(db, item_id)
    if payload.title is not None:
        item.title = payload.title
    if payload.description is not None:
        item.description = payload.description
    if payload.source_url is not None:
        item.source_url = payload.source_url
    if payload.variant_label is not None:
        item.variant_label = payload.variant_label or None
    if payload.tags is not None:
        tag_service.set_item_tags(db, item, payload.tags)
    db.commit()
    db.refresh(item)
    search.reindex_item(db, item)
    return item_out(item)


@router.post("/bulk", response_model=BulkActionResult)
def bulk_action(action: BulkAction, db: Session = Depends(get_db)) -> BulkActionResult:
    items = list(db.scalars(select(Item).where(Item.id.in_(action.item_ids))).all())
    if not items:
        return BulkActionResult(affected=0)

    if action.action in ("tag", "untag"):
        if not action.tags:
            raise HTTPException(status_code=400, detail="tags is required for tag/untag")
        for item in items:
            if action.action == "tag":
                tag_service.add_item_tags(db, item, action.tags)
            else:
                tag_service.remove_item_tags(db, item, action.tags)
        db.commit()
        for item in items:
            search.reindex_item(db, item)

    elif action.action in ("add_to_board", "remove_from_board"):
        if not action.board_id:
            raise HTTPException(status_code=400, detail="board_id is required")
        board = db.get(Board, action.board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="Board not found")
        if board.is_dynamic:
            raise HTTPException(
                status_code=400,
                detail="Dynamic boards compute their membership; edit its query tags instead",
            )
        if action.action == "add_to_board":
            next_position = (
                db.scalar(
                    select(func.coalesce(func.max(BoardItem.position), -1)).where(
                        BoardItem.board_id == board.id
                    )
                )
                or -1
            ) + 1
            for item in items:
                if db.get(BoardItem, (board.id, item.id)) is None:
                    db.add(BoardItem(board_id=board.id, item_id=item.id, position=next_position))
                    next_position += 1
        else:
            for item in items:
                link = db.get(BoardItem, (board.id, item.id))
                if link is not None:
                    db.delete(link)
        db.commit()

    elif action.action == "delete":
        now = datetime.now(timezone.utc)
        for item in items:
            item.is_deleted = True
            item.deleted_at = now
            versions.set_deleted(db, item, True, now)
        db.commit()

    elif action.action == "restore":
        for item in items:
            item.is_deleted = False
            item.deleted_at = None
            versions.set_deleted(db, item, False, None)
        db.commit()

    return BulkActionResult(affected=len(items))


@router.delete("/{item_id}", response_model=ItemOut)
def soft_delete(item_id: int, db: Session = Depends(get_db)) -> ItemOut:
    item = _get_item(db, item_id)
    now = datetime.now(timezone.utc)
    item.is_deleted = True
    item.deleted_at = now
    versions.set_deleted(db, item, True, now)
    db.commit()
    db.refresh(item)
    return item_out(item)


@router.post("/{item_id}/restore", response_model=ItemOut)
def restore(item_id: int, db: Session = Depends(get_db)) -> ItemOut:
    item = _get_item(db, item_id)
    item.is_deleted = False
    item.deleted_at = None
    versions.set_deleted(db, item, False, None)
    db.commit()
    db.refresh(item)
    return item_out(item)


@router.post("/{item_id}/crop", response_model=ItemOut, status_code=201)
def crop(item_id: int, payload: CropRequest, db: Session = Depends(get_db)) -> ItemOut:
    """Non-destructive crop: always produces a *new* derived item.

    The source is never modified, so a bad avatar crop costs nothing but a row.
    `target` locks the aspect ratio and wires the result into the right place
    (profile settings or a board cover) — the same mechanism serves all three
    destinations (architecture §2b).
    """
    source = _get_item(db, item_id)

    if payload.target:
        expected = TARGET_ASPECTS[payload.target]
        actual = payload.w / payload.h
        if abs(actual - expected) / expected > ASPECT_TOLERANCE:
            raise HTTPException(
                status_code=400,
                detail=f"{payload.target} crop must be ~{expected}:1, got {actual:.2f}:1",
            )
        if payload.target == "board_cover" and not payload.board_id:
            raise HTTPException(status_code=400, detail="board_id is required for board_cover")

    config = get_config()
    try:
        data = images.crop_bytes(
            config.data_dir / source.storage_path,
            payload.x,
            payload.y,
            payload.w,
            payload.h,
            payload.output_width,
        )
    except (images.InvalidImageError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Keyed crops live beside the photo they came from, named after it:
    # data/images/ab/<source-hash>_avatar.webp next to <source-hash>.webp. The
    # profile picture is then findable from the original rather than sitting in
    # an unrelated bucket named after its own content.
    storage_key = None
    replace_item = None
    if payload.target:
        source_stem = Path(source.storage_path).stem
        storage_key = f"{source_stem}_{payload.target}"
        # Re-cropping the same photo for the same destination updates the item
        # that already exists, so its id is stable and no orphan is left behind.
        replace_item = db.scalar(
            select(Item).where(
                Item.parent_item_id == source.id, Item.derivative_target == payload.target
            )
        )

    result = ingest.ingest(
        db,
        data,
        title=source.title,
        source_url=source.source_url,
        parent_item_id=source.id,
        derivative_target=payload.target,
        storage_key=storage_key,
        replace_item=replace_item,
    )
    derived = result.item

    # Every crop — freeform or a role crop (avatar/banner/board cover) — is
    # another view of the same artwork, so it joins that artwork's versions
    # instead of becoming an invisible side file nothing shows. Cropping a
    # version attaches to the artwork, not to the version, which is what keeps
    # version sets flat. A role crop is never made canonical: setting an
    # avatar must never change what the artwork itself displays in the grid.
    root = versions.root_of(db, source)
    try:
        versions.attach(db, root, derived)
        if payload.target is None and payload.make_canonical:
            versions.set_canonical(db, root, derived.id)
    except versions.VersionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if payload.target == "avatar":
        settings_store.set_many(db, {"profile.avatar_item_id": derived.id})
    elif payload.target == "banner":
        settings_store.set_many(db, {"profile.banner_item_id": derived.id})
    elif payload.target == "board_cover":
        board = db.get(Board, payload.board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="Board not found")
        board.cover_item_id = derived.id
        db.commit()

    return item_out(derived)


@router.get("/{item_id}/file/{kind}")
def get_file(item_id: int, kind: str, db: Session = Depends(get_db)) -> FileResponse:
    """Serve a derivative. Originals are only ever served by /download.

    This is the rule that keeps browsing fast independently of source format: a
    grid of 40 multi-megabyte PNGs is slow at any collection size, while the same
    grid of ~400px WebP thumbs is not.
    """
    if kind not in ("thumb", "display"):
        raise HTTPException(status_code=404, detail="Unknown derivative")
    item = _get_item(db, item_id)
    path = images.derivative_path(item.storage_path, kind)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Derivative missing on disk")
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": "max-age=31536000, immutable"})


@router.get("/{item_id}/download")
def download(item_id: int, db: Session = Depends(get_db)) -> FileResponse:
    item = _get_item(db, item_id)
    path = get_config().data_dir / item.storage_path
    if not path.exists():
        raise HTTPException(status_code=404, detail="Original missing on disk")
    filename = f"{item.title or item.hash[:12]}{path.suffix}"
    return FileResponse(path, media_type=item.mime_type, filename=filename)
