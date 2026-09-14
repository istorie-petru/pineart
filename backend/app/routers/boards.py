"""Board endpoints, including saved-search (dynamic) boards."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Board, BoardItem, BoardQueryTag, BoardSubboardTag, Item, ItemTag, Tag
from ..schemas import BoardIn, BoardItemsIn, BoardOut, BoardPatch, CitationExport, SubboardTagIn, TagOut
from ..serializers import board_out
from ..services import citation, queries, search
from ..services.tags import slugify

router = APIRouter(prefix="/api/boards", tags=["boards"])


def _get_board(db: Session, board_id: int) -> Board:
    board = db.get(Board, board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="Board not found")
    return board


def _unique_slug(db: Session, name: str) -> str:
    base = slugify(name)
    slug, suffix = base, 2
    while db.scalar(select(Board).where(Board.slug == slug)):
        slug = f"{base}-{suffix}"
        suffix += 1
    return slug


def _write_query_tags(db: Session, board: Board, query_tags) -> None:
    db.query(BoardQueryTag).filter(BoardQueryTag.board_id == board.id).delete()
    for qt in query_tags:
        if db.get(Tag, qt.tag_id) is None:
            raise HTTPException(status_code=400, detail=f"Unknown tag id {qt.tag_id}")
        db.add(
            BoardQueryTag(board_id=board.id, tag_id=qt.tag_id, match_mode=qt.match_mode)
        )


@router.get("", response_model=list[BoardOut])
def list_boards(db: Session = Depends(get_db)) -> list[BoardOut]:
    boards = db.scalars(select(Board).order_by(Board.position, Board.created_at)).all()
    return [board_out(db, b) for b in boards]


@router.post("", response_model=BoardOut, status_code=201)
def create_board(payload: BoardIn, db: Session = Depends(get_db)) -> BoardOut:
    next_position = (db.scalar(select(func.coalesce(func.max(Board.position), -1))) or -1) + 1
    board = Board(
        name=payload.name,
        slug=_unique_slug(db, payload.name),
        description=payload.description,
        cover_item_id=payload.cover_item_id,
        is_dynamic=payload.is_dynamic,
        position=next_position,
    )
    db.add(board)
    db.flush()
    if payload.is_dynamic:
        _write_query_tags(db, board, payload.query_tags)
    db.commit()
    db.refresh(board)
    return board_out(db, board)


@router.get("/{board_id}", response_model=BoardOut)
def get_board(board_id: int, db: Session = Depends(get_db)) -> BoardOut:
    return board_out(db, _get_board(db, board_id))


@router.patch("/{board_id}", response_model=BoardOut)
def patch_board(board_id: int, payload: BoardPatch, db: Session = Depends(get_db)) -> BoardOut:
    board = _get_board(db, board_id)
    if payload.name is not None:
        board.name = payload.name
    if payload.description is not None:
        board.description = payload.description
    if payload.cover_item_id is not None:
        if db.get(Item, payload.cover_item_id) is None:
            raise HTTPException(status_code=400, detail="cover_item_id does not exist")
        board.cover_item_id = payload.cover_item_id
    if payload.position is not None:
        board.position = payload.position
    if payload.query_tags is not None:
        if not board.is_dynamic:
            raise HTTPException(
                status_code=400, detail="query_tags only apply to dynamic boards"
            )
        _write_query_tags(db, board, payload.query_tags)
    db.commit()
    db.refresh(board)
    return board_out(db, board)


@router.delete("/{board_id}", status_code=204)
def delete_board(board_id: int, db: Session = Depends(get_db)) -> None:
    """Deletes the board only — never its items.

    A board is a view onto the collection; deleting one should not be a way to
    lose pictures, so `board_items` rows cascade but `items` rows are untouched.
    """
    board = _get_board(db, board_id)
    db.delete(board)
    db.commit()


@router.put("/{board_id}/items", response_model=BoardOut)
def set_board_items(
    board_id: int, payload: BoardItemsIn, db: Session = Depends(get_db)
) -> BoardOut:
    """Replace membership *and* order in one call — the drag-reorder save.

    No-op for dynamic boards, per architecture §2: their membership is computed,
    so accepting an arrangement here would create state that the next read throws
    away.
    """
    board = _get_board(db, board_id)
    if board.is_dynamic:
        raise HTTPException(
            status_code=400, detail="Dynamic boards do not have a stored arrangement"
        )

    found = set(db.scalars(select(Item.id).where(Item.id.in_(payload.item_ids))).all())
    missing = [i for i in payload.item_ids if i not in found]
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown item ids: {missing}")

    db.query(BoardItem).filter(BoardItem.board_id == board.id).delete()
    for position, item_id in enumerate(payload.item_ids):
        db.add(BoardItem(board_id=board.id, item_id=item_id, position=position))
    db.commit()
    db.refresh(board)
    return board_out(db, board)


@router.get("/{board_id}/citation", response_model=CitationExport)
def board_citation(board_id: int, db: Session = Depends(get_db)) -> CitationExport:
    """Citation data for every item on a board, in board order — the printable
    board index (see the board-detail print stylesheet) reads the same data."""
    board = _get_board(db, board_id)
    stmt = queries.build_query(db, parsed=search.ParsedQuery(), board=board)
    if not board.is_dynamic:
        # Static boards have a curated order (drag-reorder); citation entries
        # should read in that order, not whatever order SQLite happens to return.
        stmt = stmt.join(BoardItem, BoardItem.item_id == Item.id).where(
            BoardItem.board_id == board.id
        ).order_by(BoardItem.position)
    items = list(db.scalars(stmt).all())
    return citation.export_for(items)


@router.get("/{board_id}/tags", response_model=list[TagOut])
def board_tags(board_id: int, db: Session = Depends(get_db)) -> list[TagOut]:
    """Tags actually carried by this board's items — the candidate list for
    activating a subboard tab.

    The subboard picker used to offer every tag in the collection, which meant
    scrolling past hundreds of unrelated tags to find the handful that could
    plausibly split this particular board. Scoping to tags the board's items
    actually have makes every option a subboard that would show at least one
    item.
    """
    board = _get_board(db, board_id)
    item_ids = select(queries.build_query(db, parsed=search.ParsedQuery(), board=board).subquery().c.id)
    tags = db.scalars(
        select(Tag)
        .join(ItemTag, ItemTag.tag_id == Tag.id)
        .where(ItemTag.item_id.in_(item_ids))
        .distinct()
        .order_by(Tag.name)
    ).all()
    return [TagOut.model_validate(t) for t in tags]


@router.put("/{board_id}/subboard-tags/{tag_id}", response_model=BoardOut)
def set_subboard_tag(
    board_id: int, tag_id: int, payload: SubboardTagIn, db: Session = Depends(get_db)
) -> BoardOut:
    board = _get_board(db, board_id)
    if db.get(Tag, tag_id) is None:
        raise HTTPException(status_code=404, detail="Tag not found")
    row = db.get(BoardSubboardTag, (board.id, tag_id))
    if row is None:
        db.add(BoardSubboardTag(board_id=board.id, tag_id=tag_id, is_active=payload.is_active))
    else:
        row.is_active = payload.is_active
    db.commit()
    db.refresh(board)
    return board_out(db, board)
