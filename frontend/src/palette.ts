/**
 * Shared color constants (design-system unification pass, 2026-09-17).
 *
 * Two genuinely different things live here, kept separate on purpose:
 *
 * - ACCENT_PRESETS: the fixed 8-swatch accent picker (Settings >
 *   Appearance) — same keys/hex/order as sibling app Curodav's own
 *   deps.py::ACCENT_PRESETS (see /home/peter/Claude/Projects/
 *   DESIGN_SYSTEM.md), each pre-adjusted to clear 4.5:1 contrast against
 *   white text.
 * - TAG_PALETTE: the fallback rotation `ui.ts`'s tagColor() uses for an
 *   uncategorized tag with no color of its own — purely cosmetic, keyed
 *   by tag id so it's stable across reloads. As of 2026-09-18 (direct
 *   request: "the pills should look the same, the colors... app colors
 *   used for pills") these are the exact 16 identity hex values from
 *   sibling app Curodav's own `.tag-{name}` palette (style.css light-mode
 *   block) instead of an unrelated 8-color set, so a "red"/"blue"/etc tag
 *   reads as the same color family in both apps. Curodav pairs each of
 *   these with a separate near-white background tint (its own `.tag-*`
 *   CSS) since its pills are soft-tinted; Pineart's tag chips are filled
 *   and pair a color with a computed contrast text color instead
 *   (`readableTextColor`, right below tagColor) — a different, already
 *   theme-safe rendering convention that doesn't need to change to get
 *   the actual ask here (shared identity colors), so only the hex values
 *   moved, not the chip's visual style.
 *
 * Deliberately NOT included here: searchBar.ts's own SWATCHES. Those
 * names/hex values are a contract with the backend (backend/app/services/
 * search.py's COLOR_NAMES resolves the exact same names to the exact same
 * hex) — merging it into a "just one palette" constant would risk a
 * future edit here silently breaking `color:red`-style search filters.
 */

export const ACCENT_PRESETS: { key: string; name: string; hex: string }[] = [
  { key: "blue", name: "Blue", hex: "#0070eb" },
  { key: "red", name: "Red", hex: "#e42735" },
  { key: "purple", name: "Purple", hex: "#7857ff" },
  { key: "green", name: "Green", hex: "#1b8849" },
  { key: "teal", name: "Teal", hex: "#0d8177" },
  { key: "orange", name: "Orange", hex: "#b95d18" },
  { key: "pink", name: "Pink", hex: "#d6336c" },
  { key: "indigo", name: "Indigo", hex: "#4c51bf" },
];

export const TAG_PALETTE: string[] = [
  "#6e6e73", // gray
  "#c2760f", // orange
  "#2a8a52", // green
  "#0071e3", // blue
  "#d44c47", // red
  "#8a5cb0", // purple
  "#a98600", // yellow
  "#976d57", // brown
  "#c14c8a", // pink
  "#6b8f00", // lime
  "#059c8f", // mint
  "#1a94a8", // teal
  "#0e93c4", // cyan
  "#4b49c8", // indigo
  "#c01f8f", // magenta
  "#475569", // slate
];
