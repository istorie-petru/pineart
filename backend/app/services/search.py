"""FTS5 index maintenance and search-bar query parsing.

The search bar is the filter state (architecture §6): `tag:landscape color:#e63946`
is both what the user sees and what the backend receives. This module owns the
grammar for that string so the frontend never has to send a parallel filter object.
"""

from __future__ import annotations

import colorsys
import re
from dataclasses import dataclass, field

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..models import Item, Tag

# A leading "-" negates any token: `-tag:portrait` excludes rather than requires.
# `is:` covers the questions that are about absence itself ("which of these have
# no tags at all?"), which no amount of negating a specific tag can express.
TOKEN_RE = re.compile(
    r"(?P<negate>-)?(?P<key>tag|color|orientation|is):(?P<value>\"[^\"]+\"|\S+)",
    re.IGNORECASE,
)
VALID_ORIENTATIONS = {"portrait", "landscape", "square"}
VALID_IS = {"untagged", "tagged", "titled", "untitled"}

# Colour swatches are written into the search bar by name (`color:red`), not as
# hex, because the search bar is meant to be read and typed by a person — and
# `color:#e63946` is neither.
#
# Named colours match a *hue range*, not a distance from a representative hex.
# Perceived colour families are not evenly sized: blue spans roughly 200–260°
# while orange spans about 35°, so any single symmetric tolerance is
# simultaneously too tight for blue and too loose for orange. Measured on real
# values, two blues a person would both call blue sit 27° apart while red and
# orange sit 31° apart — a flat tolerance cannot separate those two cases, and a
# range per family can.
NAMED_COLOR_HUES: dict[str, tuple[float, float]] = {
    "red": (345, 10),
    "orange": (10, 45),
    "gold": (45, 68),
    "yellow": (45, 68),
    "green": (68, 165),
    "teal": (165, 200),
    "blue": (200, 260),
    "purple": (260, 300),
    "pink": (300, 345),
}

# Families defined by lightness rather than hue: hue is noise at these
# saturations. Each maps to the value (0..1) band it covers.
NAMED_ACHROMATIC: dict[str, tuple[float, float]] = {
    "black": (0.0, 0.25),
    "grey": (0.25, 0.75),
    "gray": (0.25, 0.75),
    "white": (0.75, 1.01),
}

# Representative hex per name, used only for rendering swatches and for the
# frontend's own preview — matching never goes through these.
NAMED_COLORS = {
    "red": "#e63946",
    "orange": "#f4a261",
    "gold": "#e9c46a",
    "yellow": "#e9c46a",
    "green": "#588157",
    "teal": "#2a9d8f",
    "blue": "#457b9d",
    "purple": "#6d597a",
    "pink": "#b56576",
    "black": "#2b2b2b",
    "white": "#f2f0ec",
    "grey": "#8d8d8d",
    "gray": "#8d8d8d",
}

# Colour matching works in HSV, not RGB.
#
# Euclidean distance in RGB was tried first and is wrong for this job: it mixes
# hue, saturation and lightness into one number, so a muted red (#9f686c) scores
# 93 away from a vivid red (#e63946) and fails to match, even though any person
# asked to sort them would put both under "red". Comparing hue separates "which
# colour is this" from "how bright and saturated is it", which is what the swatch
# filter is actually asking.
#
# Hue is meaningless for near-greys, so achromatic colours are matched on
# lightness instead — otherwise the black swatch would match any dark colour
# whose hue happened to land nearby.
# Used only for a raw hex filter (`color:#3f7a2b`), where there is no named
# family to look up.
HUE_TOLERANCE_DEGREES = 30.0
ACHROMATIC_SATURATION = 0.18
ACHROMATIC_VALUE_TOLERANCE = 0.28


@dataclass(slots=True)
class ParsedQuery:
    tags: list[str] = field(default_factory=list)
    colors: list[str] = field(default_factory=list)
    orientations: list[str] = field(default_factory=list)
    exclude_tags: list[str] = field(default_factory=list)
    exclude_colors: list[str] = field(default_factory=list)
    exclude_orientations: list[str] = field(default_factory=list)
    #: Presence flags from `is:` / `-is:`, e.g. {"untagged"} or {"tagged"}.
    flags: set[str] = field(default_factory=set)
    text: str = ""

    @property
    def is_empty(self) -> bool:
        return not (
            self.tags
            or self.colors
            or self.orientations
            or self.exclude_tags
            or self.exclude_colors
            or self.exclude_orientations
            or self.flags
            or self.text
        )


def parse(query: str | None) -> ParsedQuery:
    parsed = ParsedQuery()
    if not query:
        return parsed
    remainder = query
    for match in TOKEN_RE.finditer(query):
        key = match.group("key").lower()
        value = match.group("value").strip('"')
        negated = bool(match.group("negate"))

        if key == "tag":
            (parsed.exclude_tags if negated else parsed.tags).append(value.lower())
        elif key == "color":
            normalized = normalize_color_token(value)
            if normalized:
                (parsed.exclude_colors if negated else parsed.colors).append(normalized)
        elif key == "orientation" and value.lower() in VALID_ORIENTATIONS:
            (parsed.exclude_orientations if negated else parsed.orientations).append(value.lower())
        elif key == "is" and value.lower() in VALID_IS:
            flag = value.lower()
            # `-is:untagged` is just `is:tagged`; folding it here means the query
            # builder only ever sees the positive form.
            opposites = {"untagged": "tagged", "tagged": "untagged", "titled": "untitled", "untitled": "titled"}
            parsed.flags.add(opposites[flag] if negated else flag)
        remainder = remainder.replace(match.group(0), " ")
    parsed.text = " ".join(remainder.split())
    return parsed


def normalize_color_token(value: str) -> str | None:
    """Return a colour filter token: a family name, or a normalized hex string.

    Names are kept as names rather than resolved to hex here, because a name
    selects a whole family and a hex selects a neighbourhood around one point —
    collapsing the first into the second loses exactly the information that
    makes the swatch filter work.
    """
    candidate = value.strip().lower()
    if candidate in NAMED_COLOR_HUES or candidate in NAMED_ACHROMATIC:
        return candidate
    return normalize_hex(candidate)


def normalize_hex(value: str) -> str | None:
    candidate = value.strip().lower()
    if not candidate.startswith("#"):
        candidate = f"#{candidate}"
    if len(candidate) == 4:  # #abc -> #aabbcc
        candidate = "#" + "".join(c * 2 for c in candidate[1:])
    return candidate if re.fullmatch(r"#[0-9a-f]{6}", candidate) else None


def _rgb(hex_color: str) -> tuple[int, int, int]:
    return (
        int(hex_color[1:3], 16),
        int(hex_color[3:5], 16),
        int(hex_color[5:7], 16),
    )


def _hsv(hex_color: str) -> tuple[float, float, float]:
    """Hue in degrees, saturation and value in 0..1."""
    r, g, b = (channel / 255 for channel in _rgb(hex_color))
    hue, lightness, saturation = colorsys.rgb_to_hls(r, g, b)
    # colorsys returns HLS; convert to the HSV value/saturation this module uses.
    value = lightness + saturation * min(lightness, 1 - lightness)
    hsv_saturation = 0.0 if value == 0 else 2 * (1 - lightness / value)
    return hue * 360, hsv_saturation, value


def _in_hue_range(hue: float, span: tuple[float, float]) -> bool:
    start, end = span
    # Red wraps past 360°, so its range is expressed as (345, 10).
    return start <= hue < end if start < end else hue >= start or hue < end


def _matches_named_family(candidate: str, name: str) -> bool:
    hue, saturation, value = _hsv(candidate)
    if name in NAMED_ACHROMATIC:
        low, high = NAMED_ACHROMATIC[name]
        return saturation < ACHROMATIC_SATURATION and low <= value < high
    span = NAMED_COLOR_HUES.get(name)
    if span is None:
        return False
    # A near-grey has no meaningful hue, so it belongs to no chromatic family.
    return saturation >= ACHROMATIC_SATURATION and _in_hue_range(hue, span)


def _same_color_family(candidate: str, target: str) -> bool:
    """Hex-to-hex comparison, for a raw `color:#rrggbb` filter."""
    c_hue, c_sat, c_val = _hsv(candidate)
    t_hue, t_sat, t_val = _hsv(target)

    if t_sat < ACHROMATIC_SATURATION or c_sat < ACHROMATIC_SATURATION:
        # One of them is a grey/black/white: both must be, and at a similar
        # lightness. This is what stops "black" matching every dark colour.
        return (
            t_sat < ACHROMATIC_SATURATION
            and c_sat < ACHROMATIC_SATURATION
            and abs(c_val - t_val) <= ACHROMATIC_VALUE_TOLERANCE
        )

    # Hue is circular: 350° and 10° are 20° apart, not 340°.
    delta = abs(c_hue - t_hue) % 360
    return min(delta, 360 - delta) <= HUE_TOLERANCE_DEGREES


def matching_dominant_colors(db: Session, wanted: list[str]) -> list[str]:
    """Resolve colour filters to the exact `dominant_color` values present in the DB.

    Doing the comparison here and handing SQL a plain `IN (...)` list keeps colour
    filtering inside the same paginated query as every other filter — a Python
    post-filter would silently break cursor pagination by removing rows after the
    LIMIT had already been applied.
    """
    if not wanted:
        return []
    stored = db.scalars(
        select(Item.dominant_color).where(Item.dominant_color.is_not(None)).distinct()
    ).all()
    out = []
    for color in stored:
        try:
            if any(_matches(color, target) for target in wanted):
                out.append(color)
        except (ValueError, IndexError):
            continue
    return out


def _matches(candidate: str, target: str) -> bool:
    if target.startswith("#"):
        return _same_color_family(candidate, target)
    return _matches_named_family(candidate, target)


# --- FTS5 index -----------------------------------------------------------

CREATE_FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    title, description, tags, tokenize='unicode61'
)
"""


def reindex_item(db: Session, item: Item) -> None:
    """Rewrite one item's FTS row.

    A standalone (not external-content) FTS5 table, synced explicitly from Python
    rather than by SQL triggers. Triggers were the alternative: they'd cover
    title/description but not the `tags` column, whose content lives in a join
    table and would need three more triggers to maintain. One explicit call at
    each write site is less machinery and easier to reason about.
    """
    # Both the display name and the slug go into the index, so free-text search
    # finds "Shōyō Hinata" whether the user types the accented name, the plain
    # one, or the hyphenated slug they saw in the search bar.
    rows = db.execute(
        select(Tag.name, Tag.slug).join(Tag.items).where(Item.id == item.id)
    ).all()
    tag_names = " ".join(
        {part for name, slug in rows for part in (name, slug, slug.replace("-", " "))}
    )
    db.execute(text("DELETE FROM items_fts WHERE rowid = :id"), {"id": item.id})
    db.execute(
        text(
            "INSERT INTO items_fts(rowid, title, description, tags) "
            "VALUES (:id, :title, :description, :tags)"
        ),
        {
            "id": item.id,
            "title": item.title or "",
            "description": item.description or "",
            "tags": tag_names,
        },
    )
    db.commit()


def remove_from_index(db: Session, item_id: int) -> None:
    db.execute(text("DELETE FROM items_fts WHERE rowid = :id"), {"id": item_id})
    db.commit()


def fts_match_ids(db: Session, query: str) -> list[int]:
    """Run a free-text query, returning item ids ordered by FTS rank.

    Each user word is quoted and given a `*` prefix suffix, so "impress" finds
    "impressionism" and a stray `"` or `AND` in the input can't be interpreted as
    FTS5 syntax.
    """
    words = [w for w in re.split(r"\s+", query.strip()) if w]
    if not words:
        return []
    match_expr = " ".join(f'"{w.replace(chr(34), "")}"*' for w in words)
    rows = db.execute(
        text("SELECT rowid FROM items_fts WHERE items_fts MATCH :q ORDER BY rank"),
        {"q": match_expr},
    ).all()
    return [r[0] for r in rows]
