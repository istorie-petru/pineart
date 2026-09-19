/**
 * Inline SVG icon set.
 *
 * Design-system unification pass, 2026-09-18: sibling app Curodav's own
 * 188-icon sprite (`_icons_sprite.html`) was named canonical -- "bigger and
 * better worked" -- so most of these were re-sourced from there (its icons
 * are themselves largely verbatim Feather Icons: 24x24 viewBox, stroke-width
 * 2, round linecap/linejoin, `fill:none`/`stroke:currentColor`, the same
 * visual language this file already used). Where a concept has no Curodav
 * equivalent at all (search, crop, addBoard, scan, restore), the standard
 * Feather Icons library -- the same family Curodav draws from, under
 * different/no names there -- supplied a canonical glyph instead of a
 * hand-authored one; only `palette` (no official Feather icon exists) is a
 * genuine custom composition, built from simple stroke + filled-dot
 * primitives in the same visual language.
 *
 * Three exceptions kept from the previous Tabler-sourced set, deliberately
 * not swapped:
 *   - `kebab`: Curodav's "more" icon is three *horizontal* stroke-outlined
 *     dots (a "•••" glyph); this app's kebab trigger is a small round button
 *     that needs *vertical* dots ("⋮"), and needs them filled, not
 *     stroke-outlined, to read as solid dots rather than faint rings at the
 *     size a kebab trigger renders at. Different orientation AND different
 *     fill technique -- not a safe swap. Filled dots stay filled by setting
 *     `fill`/`stroke` directly on the element, overriding the
 *     `fill: none; stroke: currentColor` every other icon gets from
 *     `.micon svg` in styles.css.
 *   - `drag`: a 6-dot grip handle. Curodav has no grip-dot pattern anywhere
 *     in its 188 icons -- its only spatially-related icon ("move") is 4
 *     outward arrows, a different metaphor (movement vs. a grab handle).
 *     Swapping would be a regression, not an alignment.
 *   - `boards`: no Curodav icon shares this exact "rectangle with an
 *     internal grid" concept under a matching name. Its own internal split
 *     was simplified 2026-09-19 (direct feedback, referencing Pinterest's
 *     own board glyph) from a 4-cell pinwheel to a 3-cell layout -- one tall
 *     cell on the left, two stacked on the right -- the same read as
 *     Pinterest's icon, redrawn with this file's stroke-based lines instead
 *     of Pinterest's filled-compound-path technique (incompatible with
 *     `.micon svg`'s app-wide `fill: none; stroke: currentColor`).
 */

export const ICONS: Record<string, string> = {
  // Standard Feather `search` -- Curodav has no search/magnifying-glass icon
  // in its 188-icon set at all (confirmed by a full grep of every id); the
  // canonical Feather glyph fills the gap instead of a hand-authored one.
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  // Standard Feather `home` -- no Curodav equivalent (its own nav concepts
  // don't include a literal house glyph); added 2026-09-19 for the sidebar's
  // Feed item.
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  // Standard Feather `compass` -- an alternative "Discover" glyph offered
  // alongside `search`/`globe` (2026-09-19: "other variants for this icon").
  compass:
    '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  // = Curodav icon-settings
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  // Simplified from a 4-cell pinwheel to a 3-cell layout -- see module doc
  // comment.
  boards:
    '<path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12"/><path d="M12 4v16"/><path d="M12 12h8"/>',
  // = Curodav icon-calendar
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  // = Curodav icon-shuffle
  shuffle:
    '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
  // = Curodav icon-download
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  // = Curodav icon-upload
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  // Standard Feather `crop` -- no Curodav equivalent.
  crop: '<path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/>',
  // Standard Feather `plus-square` -- no Curodav equivalent; matches this
  // icon's own "plus sign centered in a rectangle" concept exactly.
  addBoard: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  // = Curodav icon-trash-2 (byte-identical geometry to icon-trash; picking
  // Curodav's newer/preferred one).
  trash:
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  // Standard Feather `rotate-ccw` -- no Curodav equivalent (icon-repeat is
  // claimed by `refresh` below, and is a different concept anyway); this is
  // the universal undo glyph rather than an exact copy of the old "circular
  // arrow with a dot" shape.
  restore: '<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  // = Curodav icon-x
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  // = Curodav icon-plus
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  // = Curodav icon-sliders
  sliders:
    '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  // Kept from Tabler -- see module doc comment.
  drag:
    '<path d="M8 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M8 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M8 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M14 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M14 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M14 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>',
  // = Curodav icon-globe
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  // = Curodav icon-image
  image: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  // Custom composition -- Feather has no official palette glyph. Outer blob
  // stroked to match Feather's weight, three small filled accent dots (the
  // same fill-a-dot technique Feather itself uses in icons like
  // more-horizontal) standing in for the three colour spots.
  palette:
    '<path d="M12 22a10 10 0 1 1 0-20 8 8 0 0 1 8 8c0 2-1 3-3 3h-2a2 2 0 0 0 0 4c0 2.5-1.5 5-3 5z"/><circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="16.5" cy="10.5" r="1" fill="currentColor" stroke="none"/>',
  // = Curodav icon-star
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  // = Curodav icon-bookmark
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  // = Curodav icon-external-link
  extlink: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  // Standard Feather `link` -- no confirmed Curodav equivalent (unlike
  // extlink's "opens in a new tab" arrow, this is the plain chain-link glyph
  // used for the Links nav item, since the page is a list of links rather
  // than a single outbound jump).
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  // = Curodav icon-folder
  folder: '<path d="M4 4h5l2 3h9a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/>',
  // = Curodav icon-heart
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  // = Curodav icon-layers
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  // = Curodav icon-camera
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  // Kept hand-drawn, not Curodav's "more" -- see module doc comment
  // (orientation + fill-technique mismatch, not a safe swap).
  kebab:
    '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
  // = Curodav icon-edit-3 (closest structural match to this app's existing
  // open-pencil silhouette; icon-edit/icon-pencil are a different shape
  // family -- a document-box combo and a closed polygon, respectively).
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  // = Curodav icon-tag
  tag: '<path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3H4a1 1 0 0 0-1 1v5.59a2 2 0 0 0 .59 1.41l9.58 9.59a2 2 0 0 0 2.83 0l4.59-4.59a2 2 0 0 0 0-2.83z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  // = Curodav icon-crosshair (circle + 4 outside ticks, the same structural
  // idea as this app's old focus icon minus a filled center dot;
  // icon-target's concentric-ring bullseye is the wrong shape family).
  focus: '<circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>',
  // = Curodav icon-merge (exact name match)
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  // = Curodav icon-quote (exact name match)
  quote: '<path d="M9 7H5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2l-2 4"/><path d="M19 7h-4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2l-2 4"/>',
  // = Curodav icon-tool
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  // = Curodav icon-repeat
  refresh: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  // Standard Feather `maximize` -- no Curodav equivalent; a 4-corner-bracket
  // frame glyph, an exact conceptual match for "scan/frame indicator".
  scan: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
};

/** Decorative icons offered wherever someone picks a glyph for something of
 * their own — link pills, and tag/category icons (a fixed small set, per
 * architecture §6) — as opposed to the rest of `ICONS`, which are UI chrome
 * (buttons, menus) not meant to be chosen from a picker. */
export const DECORATIVE_ICON_KEYS = [
  "globe",
  "image",
  "palette",
  "star",
  "bookmark",
  "extlink",
  "folder",
  "heart",
  "layers",
  "camera",
  "tag",
] as const;

export function icon(name: string, small = false): string {
  const body = ICONS[name] ?? ICONS.globe;
  return `<span class="micon${small ? " small" : ""}"><svg viewBox="0 0 24 24">${body}</svg></span>`;
}
