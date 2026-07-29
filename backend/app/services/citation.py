"""Citation/provenance export — advance.md §10.

The one feature here that's specific to this project rather than portable to
any generic image gallery: turning the citation-style fields already on an
item (title, an artist/creator tag, when it was added, where it came from)
into a structured, copy-pasteable reference. Deliberately plain text rather
than a full BibTeX implementation — enough to use the collection as an actual
research/reference tool without building a citation-format engine nobody asked
for.
"""

from __future__ import annotations

from ..models import Item
from ..schemas import CitationEntry, CitationExport

# Tags filed under a category with one of these names are treated as the
# "who made this" field. Matched case-insensitively against the category name
# so a category called "Creator" or "Artist" both work without configuration.
_ARTIST_CATEGORY_NAMES = {"creator", "artist"}


def _artist_of(item: Item) -> str | None:
    for tag in item.tags:
        if tag.category and tag.category.name.strip().lower() in _ARTIST_CATEGORY_NAMES:
            return tag.name
    return None


def entry_for(item: Item) -> CitationEntry:
    return CitationEntry(
        item_id=item.id,
        title=item.title,
        artist=_artist_of(item),
        # There is no separate "date the artwork was created" field on an item
        # (see architecture.md) — the date it was added to the collection is
        # the closest available fact, and is labelled as such below rather than
        # implied to be the artwork's actual creation date.
        creation_date=item.added_at.date().isoformat(),
        source=item.source_url,
    )


def _format_entry(entry: CitationEntry, index: int) -> str:
    lines = [f"[{index}] {entry.title or 'Untitled'}"]
    if entry.artist:
        lines.append(f"    Artist/Creator: {entry.artist}")
    lines.append(f"    Added to collection: {entry.creation_date}")
    if entry.source:
        lines.append(f"    Source: {entry.source}")
    return "\n".join(lines)


def export_for(items: list[Item]) -> CitationExport:
    entries = [entry_for(item) for item in items]
    text = "\n\n".join(_format_entry(entry, i + 1) for i, entry in enumerate(entries))
    return CitationExport(entries=entries, text=text)
