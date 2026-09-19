/**
 * Shared floating action menu -- design-system unification pass, 2026-09-18.
 *
 * Ported from sibling app Curodav's `.action-menu` component (its own
 * style.css + the action-menu IIFE in app.js): portal-to-`document.body` on
 * open, `position:fixed` with viewport-edge clamping (flips above the
 * trigger when there's no room below), full keyboard nav (Arrow Up/Down
 * cycling, Home/End, Escape returns focus to the trigger), outside-click/
 * Tab/scroll all close it, at most one menu open at a time.
 *
 * Curodav's version has the caller's markup pre-rendered by the server and
 * only wires behavior onto it -- there's no template engine here, so this
 * port is behavioral instead: callers describe the menu as data
 * (`ActionMenuOptions`) and this module builds + positions the panel itself,
 * matching the imperative `el()`-building idiom the rest of this codebase
 * already uses (see card.ts, addImagesMenu.ts).
 *
 * Two things Curodav's component doesn't have, kept here as deliberate
 * Pineart-only extensions (confirmed 2026-09-18, not a strict-parity port):
 *   - `iconRow`: groups consecutive icon-only entries into one horizontal
 *     row (card.ts's old `.kebab-icon-row` behavior).
 *   - `anchor`: opens the menu at an arbitrary point instead of off the
 *     trigger element, so right-click/long-press can reuse this menu as a
 *     context menu (card.ts's existing behavior).
 */

import { icon } from "../icons";
import { el } from "../ui";

export interface ActionMenuItem {
  label: string;
  action: string;
  icon?: string;
  danger?: boolean;
  /** Renders a divider above this item, and breaks any icon-row grouping in progress. */
  dividerBefore?: boolean;
  /** Renders an <a href> instead of a <button type="button">. */
  href?: string;
  /** Pineart-only extension -- see module doc comment. Icon-only, grouped with adjacent iconRow items. */
  iconRow?: boolean;
  /** 2026-09-18 addition (components/select.ts's custom <select> replacement,
   * ported from Curodav's own multiselect/native-select-with-highlighted-
   * current-option convention): marks this item as the currently-chosen
   * value in a single-select list, rendered with an accent-tinted
   * background -- native <select> highlights its current option the same
   * way, this just doesn't regress that when replacing it. */
  selected?: boolean;
}

export interface ActionMenuSection {
  items: ActionMenuItem[];
}

export interface ActionMenuOptions {
  trigger: HTMLElement;
  sections?: ActionMenuSection[];
  onAction?: (action: string) => void;
  ariaLabel?: string;
  /** Escape hatch for a panel that isn't a list of ActionMenuItems --
   * components/colorPicker.ts's swatch grid, for one -- while still
   * getting the shared portal/position/outside-click/Escape/Tab-close
   * machinery below for free. When set, `sections`/`onAction` are ignored;
   * the callback receives the empty panel element to fill in directly. */
  renderContent?: (panel: HTMLElement) => void;
  /** Pineart-only extension -- see module doc comment. Anchors the panel to a point
   * (clientX/clientY-derived box) instead of the trigger's own bounding box. */
  anchor?: { top: number; bottom: number; left: number; right: number };
  /** Which edge of the trigger the panel's own edge lines up with.
   * "right" (default, unchanged from before this option existed) matches a
   * kebab/overflow-menu trigger, where the panel commonly needs to extend
   * left of a small icon button. "left" matches a `<select>`-shaped
   * trigger (components/select.ts) -- panel and trigger share a left edge,
   * the way a native select's own popup does. */
  align?: "left" | "right";
  /** When set, the panel's min-width matches the trigger's own width --
   * components/select.ts uses this so the dropdown is never narrower than
   * the button that opened it, matching native <select> sizing. */
  matchTriggerWidth?: boolean;
  /** Fires whenever this menu closes, however it closes (explicit toggle, outside
   * click, Escape, Tab, scroll) -- lets a caller keep its own trigger styling
   * (e.g. card.ts's "stay visible while its menu is open" affordance) in sync
   * without needing to know which close path fired. */
  onClose?: () => void;
}

interface ActiveMenu {
  trigger: HTMLElement;
  panel: HTMLElement;
  onClose?: () => void;
}

let activeMenu: ActiveMenu | null = null;

export function closeActionMenu(): void {
  if (!activeMenu) return;
  const { panel, trigger, onClose } = activeMenu;
  panel.remove();
  trigger.setAttribute("aria-expanded", "false");
  activeMenu = null;
  onClose?.();
}

function buildPanel(options: ActionMenuOptions): HTMLElement {
  const panel = el("div", { class: "action-menu-panel", role: "menu" });
  if (options.ariaLabel) panel.setAttribute("aria-label", options.ariaLabel);

  if (options.renderContent) {
    options.renderContent(panel);
    return panel;
  }

  for (const section of options.sections ?? []) {
    const sectionEl = el("div", { class: "action-menu-section" });
    let iconRow: HTMLElement | null = null;

    for (const item of section.items) {
      if (item.dividerBefore) {
        sectionEl.append(el("div", { class: "action-menu-divider" }));
        iconRow = null;
      }

      const attrs: Record<string, string> = { class: "action-menu-item", role: "menuitem" };
      if (item.danger) attrs.class += " danger";
      if (item.selected) attrs.class += " selected";
      if (item.href) attrs.href = item.href;
      else attrs.type = "button";
      if (item.icon && item.iconRow) attrs.title = item.label;

      const entry = el(item.href ? "a" : "button", attrs);
      // Icon markup comes from our own icons.ts (trusted); the label is untrusted
      // caller text, so it's appended as a real text node rather than concatenated
      // into the innerHTML string.
      if (item.icon) entry.insertAdjacentHTML("beforeend", icon(item.icon, true));
      if (!(item.icon && item.iconRow)) entry.append(document.createTextNode(item.label));

      entry.addEventListener("click", (event) => {
        if (!item.href) event.preventDefault();
        closeActionMenu();
        options.onAction?.(item.action);
      });

      if (item.icon && item.iconRow) {
        if (!iconRow) {
          iconRow = el("div", { class: "action-menu-icon-row" });
          sectionEl.append(iconRow);
        }
        iconRow.append(entry);
      } else {
        iconRow = null;
        sectionEl.append(entry);
      }
    }

    panel.append(sectionEl);
  }

  return panel;
}

function handleKeydown(event: KeyboardEvent, panel: HTMLElement, trigger: HTMLElement): void {
  const items = Array.from(panel.querySelectorAll<HTMLElement>(".action-menu-item"));
  const currentIndex = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "Escape") {
    event.preventDefault();
    closeActionMenu();
    trigger.focus();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    (items[currentIndex + 1] || items[0])?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    (items[currentIndex - 1] || items[items.length - 1])?.focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === "End") {
    event.preventDefault();
    items[items.length - 1]?.focus();
  }
}

/** Opens a menu, closing any other open one first. Always opens -- for a
 * toggle-on-the-same-trigger button, use `toggleActionMenu` instead. */
export function openActionMenu(options: ActionMenuOptions): void {
  closeActionMenu();

  const { trigger } = options;
  const panel = buildPanel(options);
  document.body.append(panel);

  // Measure while invisible -- a freshly appended block is still shrink-to-fit
  // only once it has real layout, and we don't want a flash at the wrong spot.
  panel.style.visibility = "hidden";
  const box = options.anchor ?? trigger.getBoundingClientRect();
  if (options.matchTriggerWidth) panel.style.minWidth = `${box.right - box.left}px`;
  const panelBox = panel.getBoundingClientRect();
  let left = options.align === "left" ? box.left : box.right - panelBox.width;
  let top = box.bottom + 4;
  left = Math.max(8, Math.min(left, window.innerWidth - panelBox.width - 8));
  if (top + panelBox.height > window.innerHeight - 8) {
    top = Math.max(8, box.top - panelBox.height - 4);
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.visibility = "";

  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "true");

  panel.addEventListener("keydown", (event) => handleKeydown(event, panel, trigger));

  activeMenu = { trigger, panel, onClose: options.onClose };
}

/** Opens the menu, or closes it if it's already open for this exact trigger --
 * the click-the-same-button-again toggle every caller today wants. */
export function toggleActionMenu(options: ActionMenuOptions): void {
  if (activeMenu?.trigger === options.trigger) closeActionMenu();
  else openActionMenu(options);
}

export function isActionMenuOpenFor(trigger: HTMLElement): boolean {
  return activeMenu?.trigger === trigger;
}

// Document-level listeners, attached once. Mirrors Curodav's own: outside
// click closes, Tab closes (no focus trap inside the menu), and a fixed
// panel can't follow page scroll so any scroll closes it too.
document.addEventListener("click", (event) => {
  if (!activeMenu) return;
  const target = event.target as Node;
  if (activeMenu.panel.contains(target) || activeMenu.trigger.contains(target)) return;
  closeActionMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Tab") closeActionMenu();
});

document.addEventListener("scroll", () => closeActionMenu(), true);
