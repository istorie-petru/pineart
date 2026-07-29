"""Maintenance endpoints: integrity checking, storage reconciliation, and
retroactive near-duplicate review.

These are the operational tools that turn "hope nothing broke" into "run a
check and see" — see `advance.md` §1/§4/§10. None of them run automatically;
each is a deliberate, on-demand action a maintainer (or the purge timer, for
the ones worth scheduling) triggers.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from PIL import UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_config
from ..db import get_db
from ..models import Item
from ..schemas import (
    IntegrityIssue,
    IntegrityReport,
    NearDuplicatePair,
    ReconciliationReport,
)
from ..serializers import item_out
from ..services import images, ingest

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])

# Opening and decoding every stored original is real I/O and CPU — fine for a
# manual "check now" click, but not something to run unbounded from a repeat
# call. This caps one request's work; a collection larger than this is checked
# in more than one pass.
MAX_INTEGRITY_SCAN = 5000


@router.get("/integrity", response_model=IntegrityReport)
def check_integrity(db: Session = Depends(get_db), limit: int = MAX_INTEGRITY_SCAN) -> IntegrityReport:
    """Confirm every stored original still exists and is still a decodable image.

    Catches disk corruption or bit rot before it surfaces as a broken image in
    the UI — the check the doc calls out as worth having for something framed
    as an archive, not just a cache.

    Deliberately *not* a re-hash-and-compare-to-`items.hash` check: `hash` is
    the SHA-256 of the bytes as originally uploaded (see the note atop
    `services/images.py`), while the file on disk may be a lossless WebP
    re-encode of those same bytes when "convert PNG to WebP" is on — different
    bytes, same picture, by design. Comparing them would flag every converted
    file as "corrupt" for a reason that isn't corruption. Actually decoding the
    file and letting Pillow's own `verify()` catch truncation/bit-rot is the
    check that can't produce that false positive.
    """
    config = get_config()
    items = list(
        db.scalars(select(Item).where(Item.is_deleted.is_(False)).order_by(Item.id)).all()
    )[:limit]

    issues: list[IntegrityIssue] = []
    checked = 0
    for item in items:
        path = config.data_dir / item.storage_path
        if not path.exists():
            issues.append(
                IntegrityIssue(item_id=item.id, storage_path=item.storage_path, problem="missing")
            )
            continue
        checked += 1
        try:
            with images.Image.open(path) as img:
                img.verify()
        except (UnidentifiedImageError, OSError, ValueError):
            issues.append(
                IntegrityIssue(item_id=item.id, storage_path=item.storage_path, problem="corrupt")
            )

    return IntegrityReport(checked=checked, scanned=len(items), issues=issues)


@router.post("/reconcile", response_model=ReconciliationReport)
def reconcile(db: Session = Depends(get_db)) -> ReconciliationReport:
    """Compare the images directory against `items` rows in both directions.

    Surfaces drift from bugs, manual filesystem meddling, or an operation that
    was interrupted partway — before it becomes "why is this image broken" six
    months from now. Never deletes anything itself; it only reports.
    """
    config = get_config()
    known_paths = {
        str((config.data_dir / storage_path).resolve())
        for storage_path in db.scalars(select(Item.storage_path)).all()
    }

    orphaned_files: list[str] = []
    if config.images_dir.exists():
        for path in config.images_dir.rglob("*"):
            if not path.is_file():
                continue
            # Derivatives are named after their original (`<stem>_thumb.webp`,
            # `<stem>_display.webp`) and never have their own `items` row, so
            # they are expected to be "unknown" to this check and are skipped
            # rather than reported as orphaned.
            if path.stem.endswith(("_thumb", "_display")):
                continue
            if str(path.resolve()) not in known_paths:
                orphaned_files.append(str(path.relative_to(config.data_dir)))

    missing_files = [
        row.storage_path
        for row in db.scalars(select(Item).where(Item.is_deleted.is_(False))).all()
        if not (config.data_dir / row.storage_path).exists()
    ]

    return ReconciliationReport(
        orphaned_files=sorted(orphaned_files), missing_files=sorted(missing_files)
    )


@router.get("/near-duplicates", response_model=list[NearDuplicatePair])
def near_duplicates(db: Session = Depends(get_db)) -> list[NearDuplicatePair]:
    """All pairs of non-deleted items whose perceptual hashes are close.

    Ingest-time pHash dedup (`ingest.find_near_duplicates`) only ever compares a
    *new* upload against what's already in the collection, so it does nothing
    for near-duplicates that both entered before pHash existed, or for two
    separate crops of the same source image uploaded independently. This is
    the retroactive companion: an O(n^2) scan is fine at single-user scale and
    this endpoint is only ever called from a maintenance page, never on a hot
    path.
    """
    items = [
        i
        for i in db.scalars(
            select(Item).where(Item.is_deleted.is_(False), Item.phash.is_not(None))
        ).all()
        # Versions of the same artwork are *supposed* to look alike — that's not
        # a duplicate to review, it's the versioning feature working as intended.
        if i.version_of_id is None
    ]

    pairs: list[NearDuplicatePair] = []
    for idx, a in enumerate(items):
        for b in items[idx + 1 :]:
            distance = images.phash_distance(a.phash, b.phash)
            if distance <= ingest.PHASH_NEAR_DUPLICATE_DISTANCE:
                pairs.append(
                    NearDuplicatePair(a=item_out(a), b=item_out(b), distance=distance)
                )

    pairs.sort(key=lambda p: p.distance)
    return pairs
