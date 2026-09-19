/**
 * Custom `<select>` replacement -- design-system unification pass,
 * 2026-09-18, direct request: "the menu opened by the input thing should
 * also be custom" (a native `<select>`'s own OS-rendered popup list looks
 * nothing like the rest of the app, and can't be restyled -- sibling app
 * Curodav never lets one appear at all, replacing every select-shaped
 * choice with its own `.multiselect`/`.filter-dropdown` component instead).
 *
 * Built on top of `actionMenu.ts` rather than as a second positioning
 * system: a single-select dropdown is structurally an action menu where
 * each item's action is "pick this value" and the trigger's own label
 * reflects the current choice. `align: "left"` + `matchTriggerWidth` (both
 * added to actionMenu.ts alongside this) make the panel behave like a
 * native select's popup (same left edge, never narrower than the button)
 * rather than the right-aligned kebab-menu default.
 */

import { el } from "../ui";
import { closeActionMenu, isActionMenuOpenFor, openActionMenu, type ActionMenuItem } from "./actionMenu";

export interface SelectOption {
  value: string;
  label: string;
}

export interface CustomSelect {
  /** A `<button class="custom-select">` -- drop it in wherever a plain
   * `el("select", ...)` used to go. */
  element: HTMLButtonElement;
  /** Current value -- for call sites that read it once at submit time
   * rather than only reacting through `onChange`. */
  getValue: () => string;
  /** The current value's display label -- for call sites that need to show
   * it back to the user (e.g. a "merge into <label>?" confirmation), the
   * equivalent of a native select's `.selectedOptions[0].textContent`. */
  getLabel: () => string;
  /** Sets the value programmatically (e.g. restoring a remembered choice)
   * without going through the panel -- does NOT fire `onChange`, matching
   * a native `<select>`'s own `.value = x` (also silent). */
  setValue: (value: string) => void;
  /** Appends more choices after creation -- for a list populated by a
   * follow-up API call (e.g. uploadDialog.ts's board picker, which starts
   * with just "None" and fills in once `api.listBoards()` resolves), the
   * same way the old code did with repeated `select.append(option)`. */
  addOptions: (moreOptions: SelectOption[]) => void;
  /** Replaces the whole option list, optionally setting a new current value
   * in the same call -- for a picker that rebuilds from scratch every time
   * (settings.ts's category/merge-target pickers, previously
   * `select.replaceChildren()` + re-populate), the equivalent of a native
   * select's `.replaceChildren()` followed by `.value = x`. */
  setOptions: (newOptions: SelectOption[], newValue?: string) => void;
}

/**
 * `onChange` fires with the picked option's `value`; the trigger's own
 * label updates itself, so callers don't need to re-render anything to
 * reflect the new selection. `opts.name` sets a `name` attribute on the
 * trigger button -- the existing inline-validation pattern
 * (`ui.ts`'s `applyFieldErrors`) matches a 422's field errors against
 * `[name="..."]`, and a plain `<button>` needs this to stay discoverable
 * the same way an `<input>`/`<select>` already is.
 */
export function createSelect(
  initialOptions: SelectOption[],
  current: string,
  onChange?: (value: string) => void,
  opts: { ariaLabel?: string; name?: string } = {},
): CustomSelect {
  let options = [...initialOptions];

  const trigger = el("button", { type: "button", class: "custom-select" }) as HTMLButtonElement;
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  if (opts.ariaLabel) trigger.setAttribute("aria-label", opts.ariaLabel);
  if (opts.name) trigger.setAttribute("name", opts.name);

  const labelSpan = el("span", { class: "custom-select-label" });
  const chevron = el("span", { class: "custom-select-chevron" });
  chevron.setAttribute("aria-hidden", "true");
  trigger.append(labelSpan, chevron);

  let value = current;
  const setLabel = () => {
    labelSpan.textContent = options.find((option) => option.value === value)?.label ?? value;
  };
  setLabel();

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (isActionMenuOpenFor(trigger)) {
      closeActionMenu();
      return;
    }
    openActionMenu({
      trigger,
      align: "left",
      matchTriggerWidth: true,
      ariaLabel: opts.ariaLabel,
      sections: [
        {
          items: options.map(
            (option): ActionMenuItem => ({
              action: option.value,
              label: option.label,
              selected: option.value === value,
            }),
          ),
        },
      ],
      onAction: (action) => {
        value = action;
        setLabel();
        onChange?.(value);
      },
    });
  });

  return {
    element: trigger,
    getValue: () => value,
    getLabel: () => options.find((option) => option.value === value)?.label ?? value,
    setValue: (newValue: string) => {
      value = newValue;
      setLabel();
    },
    addOptions: (moreOptions: SelectOption[]) => {
      options.push(...moreOptions);
      setLabel(); // no-op unless `value` matches one of the newly-added options
    },
    setOptions: (newOptions: SelectOption[], newValue?: string) => {
      options = [...newOptions];
      if (newValue !== undefined) value = newValue;
      setLabel();
    },
  };
}
