/**
 * Custom icon picker -- design-system unification pass, 2026-09-19, direct
 * request: "I want drop down menus almost everywhere in the app: the icon
 * choser, the color choser." Replaces `ui.ts`'s `buildIconPicker` (an
 * always-expanded inline grid of every icon at once, taking up real
 * vertical space in every modal it appeared in) with a click-to-open
 * portal dropdown -- a trigger showing only the currently-picked icon,
 * matching the same pattern `select.ts`/`colorPicker.ts` already
 * established for single-value pickers built on `actionMenu.ts`'s shared
 * portal/position/outside-click/Escape machinery.
 */

import { icon } from "../icons";
import { el } from "../ui";
import { closeActionMenu, isActionMenuOpenFor, openActionMenu } from "./actionMenu";

export interface IconPicker {
  /** A `<button class="icon-swatch-trigger">` showing the current icon --
   * drop it in wherever `buildIconPicker(...)` used to go. */
  element: HTMLButtonElement;
  get: () => string | null;
  /** Sets the value programmatically, without going through the panel and
   * without firing `onPick` -- matches `buildIconPicker`'s own silent
   * `.set()`. */
  set: (key: string | null) => void;
}

export function createIconPicker(
  keys: readonly string[],
  initial: string | null | undefined,
  onPick?: (key: string | null) => void,
  opts: { allowNone?: boolean; ariaLabel?: string } = {},
): IconPicker {
  const trigger = el("button", { type: "button", class: "icon-swatch-trigger" }) as HTMLButtonElement;
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  if (opts.ariaLabel) trigger.setAttribute("aria-label", opts.ariaLabel);

  let chosen: string | null = initial ?? null;
  const paint = () => {
    trigger.innerHTML = chosen ? icon(chosen, true) : "—";
  };
  paint();

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (isActionMenuOpenFor(trigger)) {
      closeActionMenu();
      return;
    }
    openActionMenu({
      trigger,
      align: "left",
      ariaLabel: opts.ariaLabel,
      renderContent: (panel) => {
        const grid = el("div", { class: "icon-swatch-grid" });
        if (opts.allowNone) {
          const noneSwatch = el("button", {
            type: "button",
            class: `action-menu-item icon-swatch-option${chosen === null ? " selected" : ""}`,
            title: "No icon",
            "aria-label": "No icon",
          });
          noneSwatch.textContent = "—";
          noneSwatch.addEventListener("click", () => {
            chosen = null;
            paint();
            closeActionMenu();
            onPick?.(chosen);
          });
          grid.append(noneSwatch);
        }
        for (const key of keys) {
          const swatch = el("button", {
            type: "button",
            class: `action-menu-item icon-swatch-option${key === chosen ? " selected" : ""}`,
            title: key,
            "aria-label": key,
          });
          swatch.insertAdjacentHTML("beforeend", icon(key, true));
          swatch.addEventListener("click", () => {
            chosen = key;
            paint();
            closeActionMenu();
            onPick?.(chosen);
          });
          grid.append(swatch);
        }
        panel.append(grid);
      },
    });
  });

  return {
    element: trigger,
    get: () => chosen,
    set: (key: string | null) => {
      chosen = key;
      paint();
    },
  };
}
