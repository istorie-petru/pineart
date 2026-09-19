"""Export / import — backup, migration between instances, and between deploy modes.

The archive is a plain zip containing `manifest.json` plus the image files, so it
is inspectable and repairable with ordinary tools rather than being a
proprietary blob. Import is keyed on the content hash, which makes it idempotent:
importing the same archive twice does not duplicate anything.
"""

from __future__ import annotations

import json
import tempfile
import zipfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_config
from ..db import get_db
from ..models import (
    Board,
    BoardItem,
    BoardQueryTag,
    BoardSubboardTag,
    Item,
    Link,
    Setting,
    Tag,
)
from ..schemas import ImportResult
from ..services import ingest, search
from ..services import tags as tag_service

router = APIRouter(prefix="/api", tags=["backup"])

MANIFEST_VERSION = 1


def _dump(rows, fields) -> list[dict]:
    return [{f: getattr(r, f) for f in fields} for r in rows]


@router.get("/export")
def export_archive(background: BackgroundTasks, db: Session = Depends(get_db)) -> FileResponse:
    config = get_config()
    items = list(db.scalars(select(Item)).all())

    manifest = {
        "version": MANIFEST_VERSION,
        "items": [
            {
                "hash": i.hash,
                "phash": i.phash,
                "filename": Path(i.storage_path).name,
                "title": i.title,
                "description": i.description,
                "width": i.width,
                "height": i.height,
                "filesize": i.filesize,
                "mime_type": i.mime_type,
                "source_url": i.source_url,
                "dominant_color": i.dominant_color,
                "orientation": i.orientation,
                "derivative_target": i.derivative_target,
                "parent_hash": next(
                    (p.hash for p in items if p.id == i.parent_item_id), None
                ),
                "is_deleted": i.is_deleted,
                "deleted_at": i.deleted_at.isoformat() if i.deleted_at else None,
                "added_at": i.added_at.isoformat(),
                "tags": [t.name for t in i.tags],
            }
            for i in items
        ],
        "tags": _dump(db.scalars(select(Tag)).all(), ("name", "slug", "color")),
        "boards": [
            {
                "name": b.name,
                "slug": b.slug,
                "description": b.description,
                "is_dynamic": b.is_dynamic,
                "position": b.position,
                "cover_hash": next((i.hash for i in items if i.id == b.cover_item_id), None),
                "items": [
                    {
                        "hash": next(i.hash for i in items if i.id == bi.item_id),
                        "position": bi.position,
                    }
                    for bi in db.scalars(
                        select(BoardItem).where(BoardItem.board_id == b.id)
                    ).all()
                ],
                "query_tags": [
                    {"tag": db.get(Tag, qt.tag_id).name, "match_mode": qt.match_mode}
                    for qt in db.scalars(
                        select(BoardQueryTag).where(BoardQueryTag.board_id == b.id)
                    ).all()
                ],
                "subboard_tags": [
                    {"tag": db.get(Tag, st.tag_id).name, "is_active": st.is_active}
                    for st in db.scalars(
                        select(BoardSubboardTag).where(BoardSubboardTag.board_id == b.id)
                    ).all()
                ],
            }
            for b in db.scalars(select(Board)).all()
        ],
        "links": [
            {
                "title": link.title,
                "url": link.url,
                "description": link.description,
                "group_name": link.group_name,
                "icon": link.icon,
                "position": link.position,
                "cover_hash": next((i.hash for i in items if i.id == link.cover_item_id), None),
            }
            for link in db.scalars(select(Link)).all()
        ],
        "settings": {s.key: json.loads(s.value) for s in db.scalars(select(Setting)).all()},
    }

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, indent=2))
        for item in items:
            source = config.data_dir / item.storage_path
            if source.exists():
                # Derivatives are deliberately not archived: they are
                # regenerated at import from the original, so including them
                # would roughly double the archive for no recoverable
                # information.
                archive.write(source, f"images/{Path(item.storage_path).name}")

    background.add_task(lambda: Path(tmp.name).unlink(missing_ok=True))
    return FileResponse(tmp.name, media_type="application/zip", filename="artboard-export.zip")


@router.post("/import", response_model=ImportResult)
async def import_archive(
    file: UploadFile = File(...), db: Session = Depends(get_db)
) -> ImportResult:
    payload = await file.read()
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.write(payload)
    tmp.close()

    imported = skipped = 0
    tags_imported = boards_imported = 0
    try:
        with zipfile.ZipFile(tmp.name) as archive:
            try:
                manifest = json.loads(archive.read("manifest.json"))
            except KeyError as exc:
                raise HTTPException(
                    status_code=400, detail="Archive has no manifest.json"
                ) from exc

            for tag in manifest.get("tags", []):
                before = db.scalar(select(Tag).where(Tag.name == tag["name"]))
                created = tag_service.get_or_create(db, tag["name"], tag.get("color"))
                if before is None:
                    tags_imported += 1
                elif tag.get("color") and not created.color:
                    created.color = tag["color"]
            db.commit()

            hash_to_item: dict[str, Item] = {}
            for entry in manifest.get("items", []):
                name = entry.get("filename")
                member = f"images/{name}" if name else None
                if not member or member not in archive.namelist():
                    skipped += 1
                    continue
                data = archive.read(member)
                result = ingest.ingest(
                    db,
                    data,
                    title=entry.get("title"),
                    description=entry.get("description"),
                    source_url=entry.get("source_url"),
                    derivative_target=entry.get("derivative_target"),
                    known_hash=entry.get("hash"),
                )
                hash_to_item[entry["hash"]] = result.item
                if result.created:
                    imported += 1
                else:
                    skipped += 1
                if entry.get("tags"):
                    tag_service.add_item_tags(db, result.item, entry["tags"])
                    db.commit()
                    search.reindex_item(db, result.item)

            # Second pass: parent links can only be resolved once every item
            # exists, since an archive may list a crop before its source.
            for entry in manifest.get("items", []):
                parent_hash = entry.get("parent_hash")
                item = hash_to_item.get(entry["hash"])
                if item and parent_hash and parent_hash in hash_to_item:
                    item.parent_item_id = hash_to_item[parent_hash].id
            db.commit()

            # `manifest.get("tag_relations", [])` from an archive made before
            # manual relations were removed is intentionally ignored rather
            # than rejected — an older export should still import cleanly,
            # just without a feature that no longer exists.

            for board_data in manifest.get("boards", []):
                board = db.scalar(select(Board).where(Board.slug == board_data["slug"]))
                if board is None:
                    board = Board(
                        name=board_data["name"],
                        slug=board_data["slug"],
                        description=board_data.get("description"),
                        is_dynamic=board_data.get("is_dynamic", False),
                        position=board_data.get("position", 0),
                    )
                    db.add(board)
                    db.flush()
                    boards_imported += 1
                cover_hash = board_data.get("cover_hash")
                if cover_hash and cover_hash in hash_to_item:
                    board.cover_item_id = hash_to_item[cover_hash].id
                for entry in board_data.get("items", []):
                    item = hash_to_item.get(entry["hash"])
                    if item and db.get(BoardItem, (board.id, item.id)) is None:
                        db.add(
                            BoardItem(
                                board_id=board.id,
                                item_id=item.id,
                                position=entry.get("position", 0),
                            )
                        )
                for entry in board_data.get("query_tags", []):
                    tag = db.scalar(select(Tag).where(Tag.name == entry["tag"]))
                    if tag and db.get(BoardQueryTag, (board.id, tag.id)) is None:
                        db.add(
                            BoardQueryTag(
                                board_id=board.id,
                                tag_id=tag.id,
                                match_mode=entry.get("match_mode", "any"),
                            )
                        )
                for entry in board_data.get("subboard_tags", []):
                    tag = db.scalar(select(Tag).where(Tag.name == entry["tag"]))
                    if tag and db.get(BoardSubboardTag, (board.id, tag.id)) is None:
                        db.add(
                            BoardSubboardTag(
                                board_id=board.id,
                                tag_id=tag.id,
                                is_active=entry.get("is_active", True),
                            )
                        )
            db.commit()

            for link_data in manifest.get("links", []):
                exists = db.scalar(select(Link).where(Link.url == link_data["url"]))
                if not exists:
                    cover_hash = link_data.get("cover_hash")
                    exists = Link(
                        title=link_data["title"],
                        url=link_data["url"],
                        description=link_data.get("description"),
                        group_name=link_data.get("group_name"),
                        icon=link_data.get("icon"),
                        position=link_data.get("position", 0),
                        cover_item_id=hash_to_item[cover_hash].id if cover_hash in hash_to_item else None,
                    )
                    db.add(exists)
            db.commit()

            for key, value in (manifest.get("settings") or {}).items():
                # Profile avatar/banner ids refer to the *source* instance's item
                # ids and would point at unrelated pictures here.
                if key in ("profile.avatar_item_id", "profile.banner_item_id"):
                    continue
                row = db.get(Setting, key)
                encoded = json.dumps(value)
                if row is None:
                    db.add(Setting(key=key, value=encoded))
                else:
                    row.value = encoded
            db.commit()
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Not a valid zip archive") from exc
    finally:
        Path(tmp.name).unlink(missing_ok=True)

    return ImportResult(
        items_imported=imported,
        tags_imported=tags_imported,
        boards_imported=boards_imported,
        skipped=skipped,
    )
