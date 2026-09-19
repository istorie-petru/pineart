"""Image ingest pipeline — architecture §2a.

Responsibilities, in order: validate that the bytes really are an image (magic
bytes, not the declared filename), deduplicate on content, normalize storage
format, derive the two WebP renditions the UI actually serves, and extract the
cheap metadata (dimensions, orientation, dominant colour, perceptual hash).

Dedup hash note: `items.hash` is the SHA-256 of the *incoming* bytes, not of the
stored file. If it hashed the stored file, flipping the "convert PNG to WebP"
setting would change the hash of an unchanged source image and the same file
could be ingested twice. Hashing what the user handed us keeps identity stable
across storage-policy changes.
"""

from __future__ import annotations

import hashlib
import io
import os
import tempfile

from dataclasses import dataclass
from pathlib import Path

import imagehash
from PIL import Image, ImageOps, UnidentifiedImageError

from ..config import get_config

# Formats accepted at ingest. Anything Pillow can open but that isn't listed here
# is rejected — an allowlist, so a new Pillow plugin can't silently widen the
# accepted surface.
ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP", "GIF", "BMP", "TIFF"}

MIME_BY_FORMAT = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "WEBP": "image/webp",
    "GIF": "image/gif",
    "BMP": "image/bmp",
    "TIFF": "image/tiff",
}

EXT_BY_FORMAT = {
    "PNG": "png",
    "JPEG": "jpg",
    "WEBP": "webp",
    "GIF": "gif",
    "BMP": "bmp",
    "TIFF": "tiff",
}

THUMB_WIDTH = 400
DISPLAY_WIDTH = 1200

# 2026-09-18 (direct report: "some of the art is way too compressed, like the
# one in the banner or avatar, that are supposed to be big and beautiful, not
# lower version quality") -- avatar/banner/board_cover crops used to reuse
# `display` (1200px, quality=82 lossy), the same derivative tuned for a
# 40-tile masonry grid glanced at small. There's exactly one avatar and one
# banner per profile (and one cover per board) rather than thousands of grid
# items, so the extra bytes a much higher quality/size derivative costs are
# irrelevant in practice. HERO_TARGET_SUFFIXES matches the exact suffixes
# `routers/items.py`'s crop endpoint already keys these storage_key values
# with (`<hash>_avatar`, `<hash>_banner`, `<hash>_board_cover`).
HERO_TARGET_SUFFIXES = ("_avatar", "_banner", "_board_cover")
HERO_WIDTH = 1600
HERO_QUALITY = 95


class InvalidImageError(ValueError):
    """Raised when the uploaded bytes are not a usable image of an allowed type."""


@dataclass(slots=True)
class ProcessedImage:
    sha256: str
    phash: str
    storage_path: str
    width: int
    height: int
    filesize: int
    mime_type: str
    dominant_color: str
    orientation: str


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _open_validated(data: bytes) -> Image.Image:
    """Open image bytes, rejecting anything that isn't a real, allowed image.

    `verify()` reads the header/structure and is what makes this a magic-byte
    check rather than trusting a filename extension. It consumes the file object,
    so the image is reopened afterwards for actual work.
    """
    try:
        probe = Image.open(io.BytesIO(data))
        probe.verify()
        fmt = probe.format
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise InvalidImageError("File is not a readable image") from exc

    if fmt not in ALLOWED_FORMATS:
        raise InvalidImageError(f"Unsupported image format: {fmt}")

    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def dominant_color(img: Image.Image) -> str:
    """Most common colour after quantizing to a small palette.

    Downscaling first is not just an optimization: on a 4000px scan the exact
    per-pixel modal colour is dominated by noise, while the mode of a 64px
    thumbnail is the colour a person would actually name.
    """
    small = img.convert("RGB").resize((64, 64), Image.Resampling.LANCZOS)
    quantized = small.quantize(colors=8, method=Image.Quantize.FASTOCTREE)
    palette = quantized.getpalette() or []
    colors = quantized.getcolors(maxcolors=256) or []
    if not colors:
        return "#000000"
    _, index = max(colors, key=lambda pair: pair[0])
    r, g, b = palette[index * 3 : index * 3 + 3]
    return f"#{r:02x}{g:02x}{b:02x}"


def orientation_of(width: int, height: int) -> str:
    if width == height:
        return "square"
    return "landscape" if width > height else "portrait"


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write `data` to `path` without ever leaving a half-written file there.

    A crash or power loss mid-write to the real path leaves a truncated image
    sitting at the filename the DB row already points to — a broken image in
    the UI. Writing to a temp file in the same directory first and `os.replace`
    into place avoids that: `os.replace` is atomic on the same filesystem, so
    the visible file is always either the old complete one or the new complete
    one, never a partial one. Same-directory temp file matters too — a temp
    file on a different filesystem would make the final move a real (non-atomic)
    copy instead of a rename.
    """
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def _atomic_save_image(img: Image.Image, path: Path, fmt: str, **save_kwargs) -> None:
    """Same atomicity guarantee as `_atomic_write_bytes`, for Pillow's own `.save()`."""
    buffer = io.BytesIO()
    img.save(buffer, fmt, **save_kwargs)
    _atomic_write_bytes(path, buffer.getvalue())


def storage_dir_for(hash_hex: str) -> Path:
    """images/<first-2-hex>/ — keeps any single directory to a few hundred files.

    Flat directories with tens of thousands of entries make `ls`, backups and
    some filesystems noticeably slower; two hex characters give 256 buckets,
    which is plenty at single-user scale.
    """
    return get_config().images_dir / hash_hex[:2]


def _write_derivatives(img: Image.Image, directory: Path, stem: str, *, overwrite: bool = False) -> None:
    for suffix, target_width in (("thumb", THUMB_WIDTH), ("display", DISPLAY_WIDTH)):
        path = directory / f"{stem}_{suffix}.webp"
        if path.exists() and not overwrite:
            continue
        derivative = img.convert("RGB")
        if derivative.width > target_width:
            ratio = target_width / derivative.width
            derivative = derivative.resize(
                (target_width, max(1, round(derivative.height * ratio))),
                Image.Resampling.LANCZOS,
            )
        _atomic_save_image(derivative, path, "WEBP", quality=82, method=4)


def _write_hero_derivative(img: Image.Image, directory: Path, stem: str, *, overwrite: bool = False) -> None:
    """A much higher quality/size derivative for the handful of single-image
    "hero" surfaces (profile avatar/banner, board cover) -- see
    HERO_TARGET_SUFFIXES' own comment for why these get different treatment
    than a generic grid item's thumb/display pair."""
    path = directory / f"{stem}_hero.webp"
    if path.exists() and not overwrite:
        return
    derivative = img.convert("RGB")
    if derivative.width > HERO_WIDTH:
        ratio = HERO_WIDTH / derivative.width
        derivative = derivative.resize(
            (HERO_WIDTH, max(1, round(derivative.height * ratio))),
            Image.Resampling.LANCZOS,
        )
    _atomic_save_image(derivative, path, "WEBP", quality=HERO_QUALITY, method=4)


def process(
    data: bytes,
    *,
    convert_png_to_webp: bool,
    preserve_original: bool,
    known_hash: str | None = None,
    storage_key: str | None = None,
) -> ProcessedImage:
    """Validate, store and derive everything needed for one item row.

    `known_hash` overrides the computed content hash and exists for exactly one
    caller: import. An archive stores the *already normalized* file (a PNG that
    was converted to lossless WebP at first ingest), so re-hashing those bytes
    would produce a different identity than the manifest records — and
    re-importing a backup into the instance it came from would duplicate every
    item instead of being a no-op. The manifest's hash is the authoritative one.

    `storage_key` overrides where the file lands and what it is called. Ordinary
    uploads are stored under their own content hash, which scatters them evenly
    across buckets. An avatar or banner crop instead passes the *source* item's
    key plus a suffix, so `<hash>_avatar.webp` sits in the same directory as the
    `<hash>.webp` it was cut from: the profile images stay findable next to the
    picture they came from rather than landing in an unrelated bucket named
    after their own content.
    """
    config = get_config()
    max_bytes = config.max_upload_bytes
    if len(data) > max_bytes:
        raise InvalidImageError(f"File exceeds the {max_bytes} byte upload limit")

    img = _open_validated(data)
    source_format = img.format or "PNG"
    img = ImageOps.exif_transpose(img) or img

    hash_hex = known_hash or sha256_of(data)
    stem = storage_key or hash_hex
    # The bucket follows the stem, so a crop keyed to its source lands in the
    # source's directory rather than in one named after its own content.
    directory = storage_dir_for(stem)
    directory.mkdir(parents=True, exist_ok=True)

    # A keyed file is deliberately rewritten: re-cropping an avatar from the same
    # photo replaces it. Content-addressed files never need rewriting, because
    # identical bytes produce an identical path.
    replace = storage_key is not None

    convert = (
        convert_png_to_webp
        and not preserve_original
        and source_format == "PNG"
    )

    if convert:
        ext, mime = "webp", "image/webp"
        original_path = directory / f"{stem}.{ext}"
        if replace or not original_path.exists():
            # lossless=True: pixel-identical to the PNG, typically 20-50% smaller.
            _atomic_save_image(img, original_path, "WEBP", lossless=True, quality=100, method=4)
    else:
        ext = EXT_BY_FORMAT[source_format]
        mime = MIME_BY_FORMAT[source_format]
        original_path = directory / f"{stem}.{ext}"
        if replace or not original_path.exists():
            _atomic_write_bytes(original_path, data)

    _write_derivatives(img, directory, stem, overwrite=replace)
    if stem.endswith(HERO_TARGET_SUFFIXES):
        _write_hero_derivative(img, directory, stem, overwrite=replace)

    return ProcessedImage(
        sha256=hash_hex,
        phash=str(imagehash.phash(img)),
        storage_path=str(original_path.relative_to(config.data_dir)),
        width=img.width,
        height=img.height,
        filesize=original_path.stat().st_size,
        mime_type=mime,
        dominant_color=dominant_color(img),
        orientation=orientation_of(img.width, img.height),
    )


def crop_bytes(
    source_path: Path, x: int, y: int, w: int, h: int, output_width: int | None = None
) -> bytes:
    """Return PNG bytes of the requested crop, optionally scaled.

    `output_width` is the "resize" half of the item-detail crop/resize tool: the
    cropped region is scaled to that width, preserving aspect. Scaling *up* is
    refused rather than silently interpolating — enlarging invents detail that
    was never in the source, and a user asking for it almost always wants a
    different original, not a blurrier copy of this one.

    PNG rather than the source format because the result goes straight back
    through `process()`, which decides the real storage format from the current
    settings — encoding losslessly here avoids a generation-loss step for JPEG
    sources.

    JPEG sources are the one exception, and deliberately so: `process()` only
    treats a *PNG* original as convertible, so a JPEG-sourced crop re-encoded as
    JPEG here is written to disk unchanged. Round-tripping it through PNG instead
    would make `process()` see format "PNG" and — if the "convert PNG to WebP"
    setting is on — losslessly re-encode pixels that were never lossless to begin
    with, taking a crop that is *strictly smaller* than its JPEG source and
    turning it into a multi-times-larger file for no visible gain. A high-quality
    JPEG re-encode costs one extra (imperceptible) generation of compression and
    keeps the file size in the same ballpark as the original.
    """
    with Image.open(source_path) as img:
        source_format = img.format or "PNG"
        img = ImageOps.exif_transpose(img) or img
        box = (
            max(0, x),
            max(0, y),
            min(img.width, x + w),
            min(img.height, y + h),
        )
        if box[2] <= box[0] or box[3] <= box[1]:
            raise InvalidImageError("Crop rectangle is outside the image")
        cropped = img.crop(box)

        if output_width and output_width != cropped.width:
            if output_width > cropped.width:
                raise InvalidImageError(
                    f"Cannot enlarge: the selected area is {cropped.width}px wide"
                )
            ratio = output_width / cropped.width
            cropped = cropped.resize(
                (output_width, max(1, round(cropped.height * ratio))), Image.Resampling.LANCZOS
            )

        buffer = io.BytesIO()
        if source_format == "JPEG":
            cropped.convert("RGB").save(buffer, "JPEG", quality=92, optimize=True)
        else:
            cropped.convert("RGBA" if cropped.mode in ("RGBA", "LA", "P") else "RGB").save(
                buffer, "PNG"
            )
        return buffer.getvalue()


def derivative_path(storage_path: str, kind: str) -> Path:
    """Locate a derivative from the item's stored original.

    Derived from `storage_path` rather than recomputed from the content hash,
    because those two no longer always agree: an avatar crop is stored beside its
    source as `<source-hash>_avatar.webp`, so its thumbnail is
    `<source-hash>_avatar_thumb.webp` — not something the crop's own hash can
    tell you. Reading the location off the row is also simply more honest: the
    row already records where the file went.
    """
    original = get_config().data_dir / storage_path
    return original.with_name(f"{original.stem}_{kind}.webp")


def delete_files(storage_path: str) -> None:
    """Hard-delete an item's original and both derivatives. Missing files are fine."""
    original = get_config().data_dir / storage_path
    for path in (original, derivative_path(storage_path, "thumb"), derivative_path(storage_path, "display")):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def phash_to_int(value: str) -> int:
    """Parses a stored pHash hex string into its raw bit pattern.

    Raises `ValueError` on anything that isn't valid hex — a malformed or
    legacy phash value shouldn't be able to crash a bulk comparison; callers
    scanning many items should parse each one through this once, catch
    `ValueError` per item, and skip rather than let one bad row fail the
    whole scan (see `find_near_duplicates` and the near-duplicates endpoint).
    """
    return int(value, 16)


def phash_hamming(a: int, b: int) -> int:
    """Bit distance between two already-parsed pHash integers.

    Plain integer XOR + popcount, not `imagehash.ImageHash.__sub__` (which
    round-trips through a numpy boolean array on every call) — comparing
    every pair in a collection is O(n^2) calls, so the per-call cost matters
    far more here than it does for a one-off comparison.
    """
    return (a ^ b).bit_count()


def phash_distance(a: str, b: str) -> int:
    return phash_hamming(phash_to_int(a), phash_to_int(b))
