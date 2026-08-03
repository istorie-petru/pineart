"""Link directory — rendered as the pill row under the profile header."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Link
from ..schemas import LinkIn, LinkOut, LinkPatch

router = APIRouter(prefix="/api/links", tags=["links"])


@router.get("", response_model=list[LinkOut])
def list_links(db: Session = Depends(get_db)) -> list[LinkOut]:
    rows = db.scalars(select(Link).order_by(Link.position, Link.id)).all()
    return [LinkOut.model_validate(r) for r in rows]


@router.post("", response_model=LinkOut, status_code=201)
def create_link(payload: LinkIn, db: Session = Depends(get_db)) -> LinkOut:
    position = payload.position
    if position is None:
        position = (db.scalar(select(func.coalesce(func.max(Link.position), -1))) or -1) + 1
    link = Link(
        title=payload.title,
        url=payload.url,
        description=payload.description,
        category=payload.category,
        icon=payload.icon,
        position=position,
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return LinkOut.model_validate(link)


@router.patch("/{link_id}", response_model=LinkOut)
def patch_link(link_id: int, payload: LinkPatch, db: Session = Depends(get_db)) -> LinkOut:
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
    return LinkOut.model_validate(link)


@router.delete("/{link_id}", status_code=204)
def delete_link(link_id: int, db: Session = Depends(get_db)) -> None:
    link = db.get(Link, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Link not found")
    db.delete(link)
    db.commit()
