"""Typed access to the `settings` key/value table.

Every setting has a default here, so a fresh install behaves correctly with an
empty table and `GET /api/settings` never returns a half-populated object that
the frontend has to defensively fill in.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Setting

DEFAULTS: dict[str, Any] = {
    # Profile
    "profile.display_name": "Art Archive",
    "profile.description": "",
    "profile.avatar_item_id": None,
    "profile.banner_item_id": None,
    # Appearance
    "appearance.theme": "system",  # light | dark | system
    "appearance.accent_color": "#e63946",
    # Collection -> Browsing
    "collection.page_size": 40,
    "collection.default_sort": "added_at",  # added_at | dimensions | filesize | title
    # Auto-load the next page when the end of the grid comes into view. The
    # architecture document deliberately chose an explicit "Load more" over
    # silent infinite fetch; this makes that a preference rather than a fixed
    # decision, and the button remains either way.
    "collection.infinite_scroll": True,
    # Collection -> Storage
    "storage.convert_png_to_webp": True,
    "storage.preserve_original_bytes": False,
    "storage.trash_retention_days": 30,
    # Discovery
    "discovery.enabled": False,
    "discovery.searxng_url": "",
    # What actually gets sent upstream. `{query}` is replaced with what the user
    # typed, so they can search "Shōyō Hinata" and have the boilerplate that
    # makes image search useful appended for them.
    "discovery.query_template": "{query}",
    # Templates the user has saved, as [{"name": ..., "template": ...}].
    "discovery.templates": [],
    # Tag graph physics (architecture §4). Exposed as sliders rather than fixed
    # constants because "how spread out" and "how loosely bonded" the layout
    # feels is a matter of taste that varies with how many tags someone has —
    # a collection with a thousand tags wants a different feel than one with
    # thirty.
    "tagGraph.charge_strength": -420,  # repulsion between nodes; more negative = more spread
    "tagGraph.link_distance": 110,  # base spring length before the per-edge weight discount
    "tagGraph.link_strength": 0.2,  # how rigidly an edge holds its target distance
    # Pull toward the canvas center. A tag with no edges at all is held only by
    # this force and pushed only by charge, so it needs to be strong enough on
    # its own — 0.18 let isolated tags drift out toward the edge of the canvas.
    "tagGraph.center_strength": 0.1,
}

# Suggested starting points, offered in the UI as copy-pasteable text. Not
# written to the database — a recommendation the user can take, edit or ignore,
# rather than state that silently ages.
RECOMMENDED_TEMPLATES: list[dict[str, str]] = [
    {
        "name": "Artwork",
        "template": "{query} artwork",
        "note": "The plain case: adds the one word that steers image engines towards art rather than photos.",
    },
    {
        "name": "High resolution",
        "template": "{query} artwork high resolution",
        "note": "Biases towards larger files, which matters when the point is to keep the image.",
    },
    {
        "name": "Official art",
        "template": "{query} official art illustration",
        "note": "For characters and franchises, where you want the published art rather than fan edits.",
    },
    {
        "name": "Exact phrase",
        "template": '"{query}" artwork',
        "note": "Quotes the subject, so a multi-word name is not split apart by the engine.",
    },
    {
        "name": "Skip the aggregators",
        "template": "{query} artwork -pinterest -wallpaper",
        "note": "Excludes two common sources of re-uploads. Support for the - operator depends on the upstream engine, so treat this as best-effort.",
    },
    {
        "name": "ArtStation only",
        "template": "{query} site:artstation.com",
        "note": "Narrows to one site. Works on engines that honour site:, which most web engines do.",
    },
]

# Settings the API refuses to write with the wrong shape. Kept small on purpose:
# it exists to stop a typo'd page_size from breaking pagination, not to become a
# second schema.
_TYPES: dict[str, type | tuple[type, ...]] = {
    "collection.page_size": int,
    "collection.default_sort": str,
    "collection.infinite_scroll": bool,
    "storage.convert_png_to_webp": bool,
    "storage.preserve_original_bytes": bool,
    "storage.trash_retention_days": int,
    "discovery.enabled": bool,
    "discovery.searxng_url": str,
    "discovery.query_template": str,
    "discovery.templates": list,
    "appearance.theme": str,
    "appearance.accent_color": str,
    "tagGraph.charge_strength": (int, float),
    "tagGraph.link_distance": (int, float),
    "tagGraph.link_strength": (int, float),
    "tagGraph.center_strength": (int, float),
}

# (key, min, max) — checked generically below rather than as one-off `if`
# branches per key, since these four are all "a number in a range" and nothing
# more.
_RANGES: dict[str, tuple[float, float]] = {
    "tagGraph.charge_strength": (-2000, -1),
    "tagGraph.link_distance": (10, 600),
    "tagGraph.link_strength": (0, 3),
    # 0-1 is the actual useful range now that the frontend applies this via
    # forceX/forceY (a real per-node pull) rather than forceCenter (a rigid
    # whole-simulation recentring that only behaved sanely right around
    # strength 1, and misbehaved above it). At 1 a node is already pulled to
    # the center as hard as the other forces can meaningfully resist.
    "tagGraph.center_strength": (0, 1),
}

_ALLOWED_SORTS = {"added_at", "dimensions", "filesize", "title"}
_ALLOWED_THEMES = {"light", "dark", "system"}


# Keys under this prefix are secrets (currently the argon2 password hash). They
# live in the same table for storage convenience but are never returned by
# GET /api/settings and never writable through PUT /api/settings — otherwise the
# settings endpoint would happily hand out the password hash and accept a
# replacement for it.
PRIVATE_PREFIX = "auth."


def _is_private(key: str) -> bool:
    return key.startswith(PRIVATE_PREFIX)


def get_all(db: Session) -> dict[str, Any]:
    stored = {
        s.key: json.loads(s.value) for s in db.scalars(select(Setting)).all() if not _is_private(s.key)
    }
    return {**DEFAULTS, **stored}


def get(db: Session, key: str) -> Any:
    row = db.get(Setting, key)
    if row is None:
        return DEFAULTS.get(key)
    return json.loads(row.value)


def set_raw(db: Session, key: str, value: Any) -> None:
    """Write one setting, bypassing the public-key validation.

    Used only by the auth service for `auth.*` keys, which have no business
    going through the same path as user-editable preferences.
    """
    row = db.get(Setting, key)
    encoded = json.dumps(value)
    if row is None:
        db.add(Setting(key=key, value=encoded))
    else:
        row.value = encoded
    db.commit()


def set_many(db: Session, values: dict[str, Any]) -> dict[str, Any]:
    for key, value in values.items():
        if _is_private(key):
            raise ValueError(f"{key} cannot be set through the settings API")
        _validate(key, value)
        row = db.get(Setting, key)
        encoded = json.dumps(value)
        if row is None:
            db.add(Setting(key=key, value=encoded))
        else:
            row.value = encoded
    db.commit()
    return get_all(db)


def _validate(key: str, value: Any) -> None:
    expected = _TYPES.get(key)
    if expected is not None and value is not None:
        # bool is a subclass of int in Python; check it first so True doesn't
        # silently pass as a page_size.
        if expected is int and isinstance(value, bool):
            raise ValueError(f"{key} must be an integer, got a boolean")
        if not isinstance(value, expected):
            raise ValueError(f"{key} must be {expected.__name__}")
    if key == "collection.default_sort" and value not in _ALLOWED_SORTS:
        raise ValueError(f"default_sort must be one of {sorted(_ALLOWED_SORTS)}")
    if key == "appearance.theme" and value not in _ALLOWED_THEMES:
        raise ValueError(f"theme must be one of {sorted(_ALLOWED_THEMES)}")
    if key == "collection.page_size" and not (1 <= int(value) <= 200):
        raise ValueError("page_size must be between 1 and 200")
    if key == "storage.trash_retention_days" and int(value) < 0:
        raise ValueError("trash_retention_days must be >= 0")
    bounds = _RANGES.get(key)
    if bounds is not None and not (bounds[0] <= float(value) <= bounds[1]):
        raise ValueError(f"{key} must be between {bounds[0]} and {bounds[1]}")
    if key == "discovery.query_template" and value and "{query}" not in value:
        # Without the placeholder the template would silently replace the search
        # instead of decorating it, and every search would return the same
        # results — a confusing failure worth refusing up front.
        raise ValueError("The template must contain {query}")
    if key == "discovery.templates":
        for entry in value or []:
            if not isinstance(entry, dict) or not entry.get("name") or not entry.get("template"):
                raise ValueError("Each saved template needs a name and a template")
            if "{query}" not in entry["template"]:
                raise ValueError(f"Template '{entry['name']}' must contain {{query}}")
