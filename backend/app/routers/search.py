"""Global search across items, tags and boards."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Board, Tag
from ..schemas import BoardOut, TagOut
from ..serializers import board_out, item_out
from ..services import queries, settings_store
from ..services import search as search_service

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("")
def search(
    q: str,
    db: Session = Depends(get_db),
    cursor: str | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    """One query string, three result kinds.

    The item half honours the same `tag:`/`color:`/`orientation:` grammar as the
    collection view, so a search typed in the header and one typed in the
    Unorganized search bar behave identically.
    """
    parsed = search_service.parse(q)
    stmt = queries.build_query(db, parsed=parsed)
    page_size = limit or int(settings_store.get(db, "collection.page_size"))
    items, next_cursor, total = queries.paginate(db, stmt, limit=page_size, cursor=cursor)

    tag_matches: list[TagOut] = []
    board_matches: list[BoardOut] = []
    if parsed.text:
        needle = f"%{parsed.text.lower()}%"
        tag_matches = [
            TagOut.model_validate(t)
            for t in db.scalars(select(Tag).where(func.lower(Tag.name).like(needle)).limit(20)).all()
        ]
        board_matches = [
            board_out(db, b)
            for b in db.scalars(
                select(Board).where(func.lower(Board.name).like(needle)).limit(20)
            ).all()
        ]

    return {
        "query": q,
        "parsed": {
            "tags": parsed.tags,
            "colors": parsed.colors,
            "orientations": parsed.orientations,
            "text": parsed.text,
        },
        "items": [item_out(i) for i in items],
        "next_cursor": next_cursor,
        "total": total,
        "tags": tag_matches,
        "boards": board_matches,
    }
