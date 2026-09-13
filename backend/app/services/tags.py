"""Tag creation, assignment and the co-occurrence graph (architecture §4)."""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from ..models import Item, ItemTag, Tag, TagCategory, TagGraphRule


# Latin letters that NFKD does *not* decompose, because they are atomic
# characters rather than a base letter plus an accent. Without this table an
# ASCII fold deletes them outright, turning "Zażółć" into "zazoc" — a slug that
# is both wrong and unsearchable.
_TRANSLITERATE = {
    "ß": "ss", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe",
    "ø": "o", "Ø": "o", "ł": "l", "Ł": "l", "đ": "d", "Đ": "d",
    "ð": "d", "Ð": "d", "þ": "th", "Þ": "th", "ı": "i", "ŋ": "n",
}


def _fold_char(char: str) -> str:
    """Reduce one character to its searchable form, if it has one."""
    if char in _TRANSLITERATE:
        return _TRANSLITERATE[char]
    decomposed = "".join(
        part for part in unicodedata.normalize("NFKD", char) if not unicodedata.combining(part)
    )
    # Only accept the decomposition when it actually lands on ASCII. Applied
    # blindly it corrupts non-Latin scripts: Cyrillic "й" decomposes to "и" plus
    # a breve, so stripping marks would silently turn it into a different
    # letter and make "Кандинский" and "Кандинскии" the same tag.
    if decomposed.isascii() and decomposed.strip():
        return decomposed
    return char


def slugify(value: str) -> str:
    """Fold a display name down to a searchable, typeable identifier.

    `tags.name` keeps exactly what the user typed — "Shōyō Hinata", "Café",
    "日本画" — because that is what they want to see on the chip. The slug is the
    handle everything else uses: it is what makes the tag findable by someone
    without an accented keyboard, and what decides whether two spellings are the
    same tag.

    Latin text folds to ASCII ("Shōyō Hinata" → "shoyo-hinata"). Scripts with no
    ASCII equivalent keep their own characters ("日本画" → "日本画"), which is
    still a perfectly good unique handle — better than the empty string an
    ASCII-only fold would produce.
    """
    folded = "".join(_fold_char(char) for char in value).casefold()
    # `\w` is Unicode-aware here, so CJK and Cyrillic letters survive while
    # punctuation and whitespace collapse into separators.
    slug = re.sub(r"[\W_]+", "-", folded, flags=re.UNICODE).strip("-")
    return slug or value.strip().casefold()


def get_or_create(
    db: Session,
    name: str,
    color: str | None = None,
    category_id: int | None = None,
    link_url: str | None = None,
    icon: str | None = None,
) -> Tag:
    """Find or create a tag, treating names that share a slug as the same tag.

    Matching on the slug rather than on the lowercased name is what makes
    "Shōyō Hinata", "shoyo hinata" and "Shoyo-Hinata" one tag instead of three —
    which is the whole point of having a slug. The first spelling used wins as
    the display name; later spellings resolve to it rather than renaming it, so
    a stray typo cannot rewrite a tag you already curated.
    """
    clean = " ".join(name.split())
    if not clean:
        raise ValueError("Tag name cannot be empty")

    slug = slugify(clean)
    existing = db.scalar(select(Tag).where(Tag.slug == slug))
    if existing:
        return existing
    # An exact-name match is still checked, for tags created before slugs were
    # the identity (or restored from an older export).
    existing = db.scalar(select(Tag).where(func.lower(Tag.name) == clean.lower()))
    if existing:
        return existing

    tag = Tag(name=clean, slug=slug, color=color, category_id=category_id, link_url=link_url, icon=icon)
    db.add(tag)
    db.flush()
    return tag


def get_or_create_category(
    db: Session, name: str, color: str, links_enabled: bool = False, icon: str | None = None
) -> TagCategory:
    """Find or create a category, matching the same slug-is-identity rule as tags."""
    clean = " ".join(name.split())
    if not clean:
        raise ValueError("Category name cannot be empty")

    slug = slugify(clean)
    existing = db.scalar(select(TagCategory).where(TagCategory.slug == slug))
    if existing:
        return existing
    existing = db.scalar(select(TagCategory).where(func.lower(TagCategory.name) == clean.lower()))
    if existing:
        return existing

    next_position = db.scalar(select(func.coalesce(func.max(TagCategory.position), -1))) or -1
    category = TagCategory(
        name=clean,
        slug=slug,
        color=color,
        position=next_position + 1,
        links_enabled=links_enabled,
        icon=icon,
    )
    db.add(category)
    db.flush()
    return category


def resolve_reference(db: Session, reference: str) -> Tag | None:
    """Resolve a `tag:` token, which may be a display name or a slug."""
    clean = " ".join(reference.split())
    if not clean:
        return None
    return db.scalar(
        select(Tag).where((Tag.slug == slugify(clean)) | (func.lower(Tag.name) == clean.lower()))
    )


def resolve_names(db: Session, names: list[str], *, create: bool = True) -> list[Tag]:
    out: list[Tag] = []
    for name in names:
        if create:
            out.append(get_or_create(db, name))
        else:
            found = resolve_reference(db, name)
            if found:
                out.append(found)
    return out


def set_item_tags(db: Session, item: Item, names: list[str]) -> None:
    """Replace an item's tags wholesale."""
    tags = resolve_names(db, names)
    item.tags = tags
    db.flush()


def add_item_tags(db: Session, item: Item, names: list[str]) -> None:
    existing = {t.id for t in item.tags}
    for tag in resolve_names(db, names):
        if tag.id not in existing:
            item.tags.append(tag)
    db.flush()


def remove_item_tags(db: Session, item: Item, names: list[str]) -> None:
    # Compared by slug so untagging works whichever spelling the caller uses.
    wanted = {slugify(n) for n in names if n.strip()}
    item.tags = [t for t in item.tags if t.slug not in wanted]
    db.flush()


# Below this, a difflib ratio is noise rather than a near-miss. 0.45 is
# deliberately generous — the ask was suggestions that are similar "even
# remotely", and a suggestion you can ignore costs far less than a tag you
# cannot find.
FUZZY_THRESHOLD = 0.45


def _score(query: str, query_slug: str, tag: Tag) -> float:
    """Rank one tag against a partial query. Higher is better; 0 means no match.

    Deliberately built from cheap, explainable rules rather than one similarity
    metric. A pure edit-distance score ranks badly for the cases that matter
    most here: "hin" is a poor edit-distance match for "Shōyō Hinata" despite
    being exactly what someone typing that tag would enter, and word order
    ("hinata shoyo") destroys it entirely. Prefix and token rules catch those;
    difflib is the last resort that catches genuine typos.
    """
    name = tag.name.casefold()
    slug = tag.slug

    if query == name or query_slug == slug:
        return 100.0
    if slug.startswith(query_slug) or name.startswith(query):
        # Shorter tags rank first: typing "ink" should offer "ink" above
        # "inktober sketches".
        return 90.0 - min(len(slug), 40) / 10
    if query_slug in slug or query in name:
        return 70.0 - min(len(slug), 40) / 10

    # Word-level match, so word order and partial words both work:
    # "hinata" and "hinata shoyo" both find "Shōyō Hinata".
    tag_tokens = [token for token in slug.split("-") if token]
    query_tokens = [token for token in query_slug.split("-") if token]
    if query_tokens and all(
        any(tag_token.startswith(query_token) for tag_token in tag_tokens)
        for query_token in query_tokens
    ):
        return 60.0

    ratio = SequenceMatcher(None, query_slug, slug).ratio()
    if ratio >= FUZZY_THRESHOLD:
        return 40.0 * ratio
    # Also compare against the longest word, so a typo in one word of a
    # multi-word tag still surfaces it.
    best_token = max(
        (SequenceMatcher(None, query_slug, token).ratio() for token in tag_tokens),
        default=0.0,
    )
    if best_token >= FUZZY_THRESHOLD:
        return 35.0 * best_token
    return 0.0


def suggest(db: Session, query: str, limit: int = 12) -> list[tuple[Tag, int]]:
    """Tags similar to a partial query, best first, with their usage counts.

    An empty query returns the most-used tags, which is the useful thing to show
    before someone has typed anything.
    """
    counts = usage_counts(db)
    all_tags = list(db.scalars(select(Tag)).all())

    clean = " ".join(query.split()).casefold()
    if not clean:
        ranked = sorted(all_tags, key=lambda tag: (-counts.get(tag.id, 0), tag.name.casefold()))
        return [(tag, counts.get(tag.id, 0)) for tag in ranked[:limit]]

    query_slug = slugify(clean)
    scored = [(tag, _score(clean, query_slug, tag)) for tag in all_tags]
    matches = [(tag, score) for tag, score in scored if score > 0]
    # Usage count breaks ties, so the tag you actually use wins over one that
    # merely sorts earlier alphabetically.
    matches.sort(key=lambda pair: (-pair[1], -counts.get(pair[0].id, 0), pair[0].name.casefold()))
    return [(tag, counts.get(tag.id, 0)) for tag, _ in matches[:limit]]


def usage_counts(db: Session) -> dict[int, int]:
    rows = db.execute(
        select(ItemTag.tag_id, func.count(ItemTag.item_id))
        .join(Item, Item.id == ItemTag.item_id)
        .where(Item.is_deleted.is_(False))
        .group_by(ItemTag.tag_id)
    ).all()
    return {tag_id: count for tag_id, count in rows}


CO_OCCURRENCE_SQL = text(
    """
    SELECT it1.tag_id AS a, it2.tag_id AS b, COUNT(*) AS weight
    FROM item_tags it1
    JOIN item_tags it2
      ON it1.item_id = it2.item_id AND it2.tag_id > it1.tag_id
    JOIN items i ON i.id = it1.item_id AND i.is_deleted = 0
    GROUP BY it1.tag_id, it2.tag_id
    """
)


def _suppress_redundant_edges(
    edges: list[tuple[int, int, int]],
    category_of: dict[int, int | None],
    rules: list[TagGraphRule],
) -> list[tuple[int, int, int]]:
    """Drop computed edges a `TagGraphRule` marks as redundant.

    Example from the model docstring: Category=Anime, Show=Haikyu,
    Character=Hinata all on one pin. Raw co-occurrence draws all three edges;
    a rule (from=Category, to=Character, via=Show) says the Anime–Hinata edge
    only exists *because* Hinata already connects to a Show tag, so it adds
    nothing the Anime–Haikyu and Haikyu–Hinata edges don't already show.

    Built in two passes because the "already connects to a Show tag" check has
    to see the *complete* neighbourhood, not one edge decided so far —
    checking edge-by-edge in a single pass would make the answer depend on
    iteration order.
    """
    if not rules:
        return edges

    neighbor_categories: dict[int, set[int]] = {}
    for a, b, _weight in edges:
        cat_a, cat_b = category_of.get(a), category_of.get(b)
        if cat_b is not None:
            neighbor_categories.setdefault(a, set()).add(cat_b)
        if cat_a is not None:
            neighbor_categories.setdefault(b, set()).add(cat_a)

    def is_redundant(a: int, b: int) -> bool:
        cat_a, cat_b = category_of.get(a), category_of.get(b)
        if cat_a is None or cat_b is None:
            return False
        for rule in rules:
            # The edge is undirected, so either endpoint may be playing the
            # "from" role — check both assignments.
            for to_tag, to_cat, from_cat in ((a, cat_a, cat_b), (b, cat_b, cat_a)):
                if from_cat == rule.from_category_id and to_cat == rule.to_category_id:
                    if rule.via_category_id in neighbor_categories.get(to_tag, ()):
                        return True
        return False

    return [(a, b, w) for a, b, w in edges if not is_redundant(a, b)]


def graph(db: Session) -> tuple[list[Tag], list[tuple[int, int, int]]]:
    """Return (nodes, edges) where each edge is (a, b, weight).

    Edges are derived from `item_tags` co-occurrence, never stored, so they
    cannot drift out of sync with it.
    """
    tags = list(db.scalars(select(Tag).order_by(Tag.name)).all())
    edges: list[tuple[int, int, int]] = [
        (a, b, weight) for a, b, weight in db.execute(CO_OCCURRENCE_SQL).all()
    ]

    rules = list(db.scalars(select(TagGraphRule)).all())
    if rules:
        category_of = {t.id: t.category_id for t in tags}
        edges = _suppress_redundant_edges(edges, category_of, rules)

    return tags, edges


def recommendations(db: Session, item: Item, limit: int = 12) -> list[Item]:
    """Tag-overlap recommendations, dominant colour as fallback (architecture §3).

    Plain SQL by design — no embeddings, no external model. Items sharing the
    most tags win; if the item has no tags at all (or too few neighbours), the
    list is topped up with items of a similar dominant colour so the strip is
    never empty.
    """
    tag_ids = [t.id for t in item.tags]
    results: list[Item] = []

    if tag_ids:
        overlap = (
            select(Item, func.count(ItemTag.tag_id).label("shared"))
            .join(ItemTag, ItemTag.item_id == Item.id)
            .where(
                ItemTag.tag_id.in_(tag_ids),
                Item.id != item.id,
                Item.is_deleted.is_(False),
            )
            .group_by(Item.id)
            .order_by(text("shared DESC"), Item.added_at.desc())
            .limit(limit)
        )
        results = [row[0] for row in db.execute(overlap).all()]

    if len(results) < limit and item.dominant_color:
        exclude = {item.id, *(r.id for r in results)}
        filler = db.scalars(
            select(Item)
            .where(
                Item.is_deleted.is_(False),
                Item.id.not_in(exclude),
                Item.dominant_color == item.dominant_color,
            )
            .order_by(Item.added_at.desc())
            .limit(limit - len(results))
        ).all()
        results.extend(filler)

    return results
