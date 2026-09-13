/** The image card used by every grid (feed, unorganized, board detail, trash). */

import { icon } from "../icons";
import type { Item } from "../types";
import { el } from "../ui";

export interface CardMenuAction {
  action: string;
  label: string;
  /** Render as an icon-only button (grouped into a row with adjacent icon
   * actions) instead of a full-width text row. */
  icon?: string;
  /** Draw a horizontal divider above this action, separating it from
   * whatever came before. */
  dividerBefore?: boolean;
}

export interface CardOptions {
  /**
   * Adds a "Bulk select" entry to the ⋮ menu — there is no permanently-visible
   * checkbox any more. Picking it selects that one card and flips the grid
   * into selecting mode; from then on a plain click on any card toggles it,
   * so selecting twenty images is twenty clicks, not twenty precise hits on a
   * 20px checkbox.
   */
  withSelect?: boolean;
  draggable?: boolean;
  menuActions?: CardMenuAction[];
  /**
   * Label and handler for the button on the hover overlay (§7: "a small 'Save'
   * affordance ... appears on the overlay"). In the Feed that action is
   * literally Save; inside your own collection nothing needs saving, so the
   * same slot carries the next most useful one-click action instead of
   * rendering an overlay with nothing in it.
   */
  overlayAction?: { label: string; onClick: (item: Item) => void };
  onOpen?: (item: Item) => void;
  onMenuAction?: (action: string, item: Item) => void;
  onToggleSelect?: (item: Item, selected: boolean) => void;
  /** True once at least one item is selected — see `withSelect`. */
  isSelecting?: () => boolean;
  /** Extra nodes rendered inside the card, e.g. the trash restore/purge row. */
  extra?: (item: Item) => HTMLElement | null;
  /**
   * Shift/Ctrl/Cmd+click (desktop) or long-press (touch) on a card, wired up
   * by `Grid` rather than handled inline here: a shift-range-select needs to
   * know every other card's position in the list, which only the grid has.
   * Returning nothing (the common no-op-until-Grid-wires-it case) falls back
   * to a plain single-card toggle so a card used outside a `Grid` (there are
   * none today, but nothing enforces it) still degrades sensibly.
   */
  onModifierSelect?: (item: Item, event: { shiftKey: boolean }) => void;
}

// Registry of currently-open kebab menus' own close functions. A menu is
// reparented to `document.body` while open (see `openMenu` below) so it can
// never be clipped by a card's `overflow: hidden` — a masonry card is
// deliberately clipped for its rounded corners, and for a short, wide pin
// there is barely any height left below the ⋮ button before hitting that
// clip, which cut the bottom of the menu off before this. Because the menu
// moves, closing it is more than a class toggle: this registry is what lets
// one shared "close everything else" handler close a menu without needing to
// know where in the DOM it currently lives.
const openKebabMenus = new Set<() => void>();

function closeAllKebabMenus(except?: () => void): void {
  for (const close of [...openKebabMenus]) {
    if (close !== except) close();
  }
}

export function makeCard(item: Item, options: CardOptions = {}): HTMLElement {
  const card = el("div", { class: `card${options.draggable ? " drag-item" : ""}` });
  card.dataset.itemId = String(item.id);

  const img = el("img", {
    class: "art",
    src: item.urls.thumb,
    alt: item.title ?? "",
    loading: "lazy",
    decoding: "async",
  }) as HTMLImageElement;
  // Reserving the exact box before the image loads is what stops the grid from
  // reflowing as thumbnails arrive; the dominant colour makes the reserved space
  // read as the picture arriving rather than as a hole in the layout.
  img.style.aspectRatio = `${item.width} / ${item.height}`;
  img.style.background = item.dominant_color ?? "var(--color-surface-2)";
  // Stops the shimmer (styles.css `.card .art`) once the real thumbnail is
  // actually in — otherwise it would play forever over a loaded image
  // instead of only over the placeholder it's meant to animate.
  const stopShimmer = () => img.classList.add("loaded");
  if (img.complete) stopShimmer();
  else img.addEventListener("load", stopShimmer, { once: true });
  card.append(img);

  const toggleSelection = () => {
    const selected = card.classList.toggle("selected");
    options.onToggleSelect?.(item, selected);
  };

  if (options.draggable) {
    card.append(el("div", { class: "handle" }, icon("drag", true)));
  }

  const overlay = el("div", { class: "overlay" });
  if (options.overlayAction) {
    const action = el("button", { class: "save-btn", type: "button" });
    action.textContent = options.overlayAction.label;
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      options.overlayAction?.onClick(item);
    });
    overlay.append(action);
  }
  card.append(overlay);

  // "Bulk select" goes in first, ahead of whatever the caller passed — it's
  // the entry point into selecting mode, so it reads as the first thing on
  // offer rather than buried among per-item actions. A divider separates it
  // from the caller's own actions the same way any other group break does.
  const menuActions: CardMenuAction[] = [];
  if (options.withSelect) menuActions.push({ action: "__bulk_select", label: "Bulk select" });
  (options.menuActions ?? []).forEach((action, index) => {
    menuActions.push(index === 0 && options.withSelect ? { ...action, dividerBefore: true } : action);
  });

  if (menuActions.length) {
    const wrap = el("div", { class: "kebab-wrap" });
    const button = el("button", { class: "kebab-btn", "aria-label": "More actions" }, icon("kebab", true));
    const menu = el("div", { class: "kebab-menu" });
    // Consecutive icon-only actions share one horizontal row (e.g. Tags / Add
    // to board / Delete below the divider) rather than each getting its own
    // full-width block row like the text actions above them.
    let iconRow: HTMLElement | null = null;
    for (const action of menuActions) {
      if (action.dividerBefore) {
        menu.append(el("div", { class: "kebab-divider" }));
        iconRow = null;
      }
      const entry = el(
        "button",
        action.icon
          ? { type: "button", class: "icon-only", title: action.label, "aria-label": action.label }
          : { type: "button" },
      );
      if (action.icon) entry.innerHTML = icon(action.icon, true);
      else entry.textContent = action.label;
      entry.addEventListener("click", (event) => {
        event.stopPropagation();
        closeMenu();
        if (action.action === "__bulk_select") toggleSelection();
        else options.onMenuAction?.(action.action, item);
      });
      if (action.icon) {
        if (!iconRow) {
          iconRow = el("div", { class: "kebab-icon-row" });
          menu.append(iconRow);
        }
        iconRow.append(entry);
      } else {
        iconRow = null;
        menu.append(entry);
      }
    }

    // Reparented to `document.body` and positioned in fixed coordinates
    // while open — see the `openKebabMenus` comment above for why a plain
    // CSS-absolute menu inside the card isn't good enough. `anchor` defaults
    // to the ⋮ button's own position, but right-click and long-press (below)
    // pass the cursor/touch point instead, so the same menu also works as a
    // context menu without needing a second implementation of it.
    const openMenu = (anchor?: { top: number; bottom: number; left: number; right: number }) => {
      document.body.append(menu);
      menu.classList.add("open");
      wrap.classList.add("open");
      // Measure off-screen first: right after appending, the menu is still a
      // plain `position: static` block in `document.body`'s flow, so it
      // stretches to the body's full width and `getBoundingClientRect()`
      // would report that width — not the ~190px the menu actually renders
      // at — which pushed every menu's left edge to the far left of the page.
      // Setting `position: fixed` before measuring gives it its real,
      // shrink-to-fit size.
      menu.style.position = "fixed";
      menu.style.top = "-9999px";
      menu.style.left = "-9999px";
      const box = anchor ?? button.getBoundingClientRect();
      const menuBox = menu.getBoundingClientRect();
      let top = box.bottom + 6;
      // Flips above the button instead of below when there isn't room —
      // exactly the "wide, short pin" case: the ⋮ sits close to the bottom
      // of the viewport more often when the card itself is short.
      if (top + menuBox.height > window.innerHeight - 8) {
        top = Math.max(8, box.top - menuBox.height - 6);
      }
      const left = Math.max(8, Math.min(box.right - menuBox.width, window.innerWidth - menuBox.width - 8));
      menu.style.position = "fixed";
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
      menu.style.right = "auto";
      openKebabMenus.add(closeMenu);
    };
    const closeMenu = () => {
      menu.classList.remove("open");
      wrap.classList.remove("open");
      menu.style.position = menu.style.top = menu.style.left = menu.style.right = "";
      if (menu.parentElement !== wrap) wrap.append(menu);
      openKebabMenus.delete(closeMenu);
    };

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = menu.classList.contains("open");
      closeAllKebabMenus();
      if (!isOpen) openMenu();
    });
    wrap.append(button, menu);
    card.append(wrap);

    // Right-click / long-press: the same menu, opened at the cursor/touch
    // point instead of at the ⋮ button — a faster path to what the ⋮ menu
    // already offers, not a second set of actions to maintain.
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      closeAllKebabMenus();
      const point = { top: event.clientY, bottom: event.clientY, left: event.clientX, right: event.clientX };
      openMenu(point);
    });

    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let pressStartX = 0;
    let pressStartY = 0;
    const LONG_PRESS_MS = 500;
    const MOVE_TOLERANCE = 10;
    const cancelPress = () => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    card.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length !== 1) return;
        pressStartX = event.touches[0].clientX;
        pressStartY = event.touches[0].clientY;
        cancelPress();
        pressTimer = setTimeout(() => {
          pressTimer = null;
          if (navigator.vibrate) navigator.vibrate(15);
          closeAllKebabMenus();
          const point = { top: pressStartY, bottom: pressStartY, left: pressStartX, right: pressStartX };
          openMenu(point);
        }, LONG_PRESS_MS);
      },
      { passive: true },
    );
    card.addEventListener(
      "touchmove",
      (event) => {
        const touch = event.touches[0];
        if (!touch) return;
        if (
          Math.abs(touch.clientX - pressStartX) > MOVE_TOLERANCE ||
          Math.abs(touch.clientY - pressStartY) > MOVE_TOLERANCE
        ) {
          cancelPress();
        }
      },
      { passive: true },
    );
    card.addEventListener("touchend", cancelPress);
    card.addEventListener("touchcancel", cancelPress);
  } else if (options.withSelect) {
    // No ⋮ menu on this card at all (rare, but not enforced) — long-press
    // still has to do *something* useful on touch, since there is no hover
    // checkbox to fall back on. Bare toggle-select is the reasonable default.
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let pressStartX = 0;
    let pressStartY = 0;
    const cancelPress = () => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    card.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length !== 1) return;
        pressStartX = event.touches[0].clientX;
        pressStartY = event.touches[0].clientY;
        cancelPress();
        pressTimer = setTimeout(() => {
          pressTimer = null;
          if (navigator.vibrate) navigator.vibrate(15);
          if (!options.isSelecting?.()) toggleSelection();
        }, 500);
      },
      { passive: true },
    );
    card.addEventListener(
      "touchmove",
      (event) => {
        const touch = event.touches[0];
        if (!touch) return;
        if (Math.abs(touch.clientX - pressStartX) > 10 || Math.abs(touch.clientY - pressStartY) > 10) cancelPress();
      },
      { passive: true },
    );
    card.addEventListener("touchend", cancelPress);
    card.addEventListener("touchcancel", cancelPress);
  }

  const extra = options.extra?.(item);
  if (extra) card.append(extra);

  card.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest(".kebab-wrap") || target.closest(".trash-actions") || target.closest(".save-btn")) return;
    // Ctrl/Cmd+click toggles just this card; Shift+click extends a range from
    // whichever card was last clicked. Both work immediately, without first
    // entering selection mode through the ⋮ menu's "Bulk select" — that
    // entry point still exists for a touch/no-modifier-keys workflow, this is
    // the desktop file-manager-style shortcut for the same result.
    if (options.withSelect && (event.ctrlKey || event.metaKey || event.shiftKey)) {
      event.preventDefault();
      if (options.onModifierSelect) options.onModifierSelect(item, { shiftKey: event.shiftKey });
      else toggleSelection();
      return;
    }
    if (options.withSelect && options.isSelecting?.()) {
      toggleSelection();
      return;
    }
    options.onOpen?.(item);
  });

  return card;
}

// One document-level listener closes any open kebab menu, rather than one
// listener per card. Checks both `.kebab-wrap` (the trigger button, still in
// its card) and `.kebab-menu` (reparented to `document.body` while open —
// see `openKebabMenus` above) since a click has to miss both to count as
// "outside".
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest(".kebab-wrap") && !target.closest(".kebab-menu")) {
    closeAllKebabMenus();
  }
});
