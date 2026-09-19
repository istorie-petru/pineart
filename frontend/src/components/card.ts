/** The image card used by every grid (feed, unorganized, board detail, trash). */

import { icon } from "../icons";
import type { Item } from "../types";
import { el } from "../ui";
import { closeActionMenu, isActionMenuOpenFor, openActionMenu, type ActionMenuItem } from "./actionMenu";

export interface CardMenuAction {
  action: string;
  label: string;
  /** Render as an icon-only button (grouped into a row with adjacent icon
   * actions) instead of a full-width text row. */
  icon?: string;
  /** Draw a horizontal divider above this action, separating it from
   * whatever came before. */
  dividerBefore?: boolean;
  /** Curodav's own action-menu convention for a destructive action (red text,
   * red-tinted hover) -- added 2026-09-18, direct report that the migration
   * onto actionMenu.ts never actually wired this through, so every call
   * site's "Delete" entry still rendered in the plain muted icon-row color. */
  danger?: boolean;
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

    // Consecutive icon-only actions share one horizontal row (e.g. Tags / Add
    // to board / Delete below the divider) rather than each getting its own
    // full-width block row like the text actions above them -- `iconRow` is
    // the shared action-menu component's equivalent of this file's old
    // manual icon-row grouping, kept as a Pineart-only extension there too.
    const menuItems: ActionMenuItem[] = menuActions.map((action) => ({
      action: action.action,
      label: action.label,
      icon: action.icon,
      dividerBefore: action.dividerBefore,
      danger: action.danger,
      iconRow: Boolean(action.icon),
    }));

    // Uses the shared action-menu component (components/actionMenu.ts, ported
    // from sibling app Curodav's `.action-menu` -- design-system unification
    // pass, 2026-09-18) for the portal-to-body/position:fixed/keyboard-nav
    // plumbing. `anchor` defaults to the ⋮ button's own position, but
    // right-click and long-press (below) pass the cursor/touch point instead,
    // so the same menu also works as a context menu without a second
    // implementation of it.
    const openMenu = (anchor?: { top: number; bottom: number; left: number; right: number }) => {
      wrap.classList.add("open");
      openActionMenu({
        trigger: button,
        anchor,
        ariaLabel: "More actions",
        sections: [{ items: menuItems }],
        onAction: (action) => {
          if (action === "__bulk_select") toggleSelection();
          else options.onMenuAction?.(action, item);
        },
        onClose: () => wrap.classList.remove("open"),
      });
    };

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (isActionMenuOpenFor(button)) closeActionMenu();
      else openMenu();
    });
    wrap.append(button);
    card.append(wrap);

    // Right-click / long-press: the same menu, opened at the cursor/touch
    // point instead of at the ⋮ button — a faster path to what the ⋮ menu
    // already offers, not a second set of actions to maintain.
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
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
