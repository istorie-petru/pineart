"""Link directory — rendered as its own page, grouped and grid-carded."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Item, Link
from ..schemas import LinkIn, LinkOut, LinkPatch
from ..services import images, ingest, link_preview

router = APIRouter(prefix="/api/links", tags=["links"])


def _out(db: Session, link: Link) -> LinkOut:
    cover_url = None
    if link.cover_item_id is not None and db.get(Item, link.cover_item_id) is not None:
        cover_url = f"/api/items/{link.cover_item_id}/file/thumb"
    return LinkOut(
        id=link.id,
        title=link.title,
        url=link.url,
        description=link.description,
        group_name=link.group_name,
        icon=link.icon,
        position=link.position,
        cover_item_id=link.cover_item_id,
        cover_url=cover_url,
    )


def _set_cover_from_bytes(db: Session, link: Link, data: bytes) -> None:
    """Shared by the manual upload endpoint and the auto-fetched-preview path
    below -- both just need "this link's cover is now these bytes".

    Stored as a real item keyed to this link (`link_<id>_cover`, mirroring the
    avatar/banner/board-cover convention in routers/items.py's crop endpoint)
    so this reuses the existing ingest/derivative pipeline rather than a
    second one-off image path. `derivative_target="link_cover"` keeps it out
    of the main grid the same way those covers already are.
    """
    # Only ever replaces an item *this* mechanism created earlier -- never some
    # unrelated item `cover_item_id` might point at because an earlier upload's
    # bytes happened to match something already in the collection (ingest.py's
    # content-hash dedup hands back that existing item rather than erroring,
    # since `items.hash` is unique). Without this check, setting a new cover
    # afterwards would see that borrowed item sitting at `cover_item_id` and
    # overwrite it in place -- corrupting someone's actual artwork rather than
    # just re-borrowing it again.
    replace_item = db.get(Item, link.cover_item_id) if link.cover_item_id is not None else None
    if replace_item is not None and replace_item.derivative_target != "link_cover":
        replace_item = None
    result = ingest.ingest(
        db,
        data,
        title=link.title,
        derivative_target="link_cover",
        storage_key=f"link_{link.id}_cover",
        replace_item=replace_item,
    )
    link.cover_item_id = result.item.id
    db.commit()


async def _maybe_autofetch_cover(db: Session, link: Link) -> None:
    """Unfurls a preview image from the link's own URL when it doesn't have a
    cover yet -- same idea as a chat app's link preview, done once so a fresh
    link isn't just a bare icon by default.

    Best-effort and silent: a slow or broken site, or one with no og:image,
    must never stop the link itself from being created or edited. An existing
    cover (manually uploaded or fetched earlier) is never replaced by this --
    it only ever fills in a blank.
    """
    if link.cover_item_id is not None:
        return
    data = await link_preview.fetch_preview_image(link.url)
    if not data:
        return
    try:
        _set_cover_from_bytes(db, link, data)
    except images.InvalidImageError:
        pass


@router.get("", response_model=list[LinkOut])
def list_links(db: Session = Depends(get_db)) -> list[LinkOut]:
    rows = db.scalars(select(Link).order_by(Link.position, Link.id)).all()
    return [_out(db, r) for r in rows]


@router.post("", response_model=LinkOut, status_code=201)
async def create_link(payload: LinkIn, db: Session = Depends(get_db)) -> LinkOut:
    position = payload.position
    if position is None:
        position = (db.scalar(select(func.coalesce(func.max(Link.position), -1))) or -1) + 1
    link = Link(
        title=payload.title,
        url=payload.url,
        description=payload.description,
        group_name=payload.group_name,
        icon=payload.icon,
        position=position,
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    await _maybe_autofetch_cover(db, link)
    return _out(db, link)


@router.patch("/{link_id}", response_model=LinkOut)
async def patch_link(link_id: int, payload: LinkPatch, db: Session = Depends(get_db)) -> LinkOut:
    link = db.get(Link, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Link not found")
    data = payload.model_dump(exclude_unset=True)
    if "url" in data and data["url"] and not data["url"].startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="url must start with http:// or https://")
    for field, value in data.items():
        setattr(link, field, value)
    db.commit()
    db.refresh(link)
    # A changed URL is the one case worth trying again for: the old URL may
    # never have had a usable preview, and the new one might.
    if "url" in data:
        await _maybe_autofetch_cover(db, link)
    return _out(db, link)


@router.delete("/{link_id}", status_code=204)
def delete_link(link_id: int, db: Session = Depends(get_db)) -> None:
    link = db.get(Link, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Link not found")
    db.delete(link)
    db.commit()


@router.post("/{link_id}/cover", response_model=LinkOut, status_code=201)
async def set_link_cover(
    link_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)
) -> LinkOut:
    """Uploads (or replaces) a link's preview image, overriding any auto-fetched one."""
    link = db.get(Link, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Link not found")

    data = await file.read()
    try:
        _set_cover_from_bytes(db, link, data)
    except images.InvalidImageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    db.refresh(link)
    return _out(db, link)
