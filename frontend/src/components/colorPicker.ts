/**
 * Custom color-swatch picker -- design-system unification pass, 2026-09-18,
 * replacing the native `<input type="color">` (the OS's own color-wheel
 * dialog, visually and functionally unrelated to the rest of the app) with
 * a portal-to-body grid of `TAG_PALETTE`'s 16 swatches -- the same 16
 * identity colors ported from sibling app Curodav's own `.tag-{name}`
 * palette in an earlier pass, here reused as picker choices rather than
 * only as the fallback-rotation array `tagColor()` draws from.
 *
 * Built the same way as `select.ts`: on top of `actionMenu.ts`'s shared
 * portal/position/outside-click/Escape machinery, via the `renderContent`
 * escape hatch (a color grid isn't a list of ActionMenuItems).
 */

import { TAG_PALETTE } from "../palette";
import { el } from "../ui";
import { closeActionMenu, isActionMenuOpenFor, openActionMenu } from "./actionMenu";

export interface ColorPicker {
  /** A `<button class="color-swatch-trigger">` filled with the current
   * color -- drop it in wherever a plain `el("input", {type:"color"})`
   * used to go. */
  element: HTMLButtonElement;
  getValue: () => string;
  /** Sets the value programmatically, without going through the panel and
   * without firing `onChange` -- matches a native color input's own
   * `.value = x` (also silent). */
  setValue: (hex: string) => void;
}

export function createColorPicker(
  current: string,
  onChange?: (hex: string) => void,
  ariaLabel = "Color",
  opts: {
    /** Swatch choices, each with an optional display name for `title`/
     * `aria-label` -- defaults to `TAG_PALETTE` (bare hex, no names). Named
     * presets (e.g. the Settings > Appearance accent-color row's
     * `ACCENT_PRESETS`, "Blue"/"Teal"/...) need this so a screen reader
     * announces the preset's name instead of a raw hex value -- a `string[]`
     * palette wouldn't carry that. */
    palette?: { hex: string; name?: string }[];
  } = {},
): ColorPicker {
  const palette: { hex: string; name?: string }[] = opts.palette ?? TAG_PALETTE.map((hex) => ({ hex }));
  const trigger = el("button", { type: "button", class: "color-swatch-trigger" }) as HTMLButtonElement;
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", ariaLabel);

  let value = current;
  const paint = () => {
    trigger.style.background = value;
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
      ariaLabel,
      renderContent: (panel) => {
        const grid = el("div", { class: "color-swatch-grid" });
        for (const { hex, name } of palette) {
          const swatch = el("button", {
            type: "button",
            class: `action-menu-item color-swatch-option${hex === value ? " selected" : ""}`,
            style: `background:${hex};`,
            title: name ?? hex,
            "aria-label": name ?? hex,
          });
          swatch.addEventListener("click", () => {
            value = hex;
            paint();
            closeActionMenu();
            onChange?.(value);
          });
          grid.append(swatch);
        }
        panel.append(grid);
      },
    });
  });

  return {
    element: trigger,
    getValue: () => value,
    setValue: (hex: string) => {
      value = hex;
      paint();
    },
  };
}
