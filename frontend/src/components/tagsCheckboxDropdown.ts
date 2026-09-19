/**
 * Checkbox dropdown for picking a set of tags -- replaces the always-expanded
 * `.checkbox-list` (every tag its own row, the block scrolling internally)
 * that the saved-search board tag picker (boardModal.ts / boardDetail.ts)
 * used to show, with a single "Tags (N)" trigger that opens a floating panel
 * of checkboxes -- matching sibling app Curodav's own Labels multiselect
 * (`_widget_list_multiselect.html` / static/app.js's `.multiselect` handling)
 * instead of a flat list competing with the rest of the form for space.
 *
 * Built the same way as select.ts/colorPicker.ts: on top of actionMenu.ts's
 * shared portal/position/outside-click/Escape machinery, via the
 * `renderContent` escape hatch (a checkbox list isn't a list of
 * ActionMenuItems). Unlike either of those -- which close the panel the
 * moment something is picked -- checking a box here does NOT close the
 * panel: picking several tags is the whole point, so it only closes the
 * normal ways (outside click/Escape/Tab/scroll, see actionMenu.ts).
 */

import { el } from "../ui";
import { closeActionMenu, isActionMenuOpenFor, openActionMenu } from "./actionMenu";

export interface TagsCheckboxDropdownItem {
  id: number;
  name: string;
}

export interface TagsCheckboxDropdown {
  /** A `<button class="custom-select">` -- drop it in wherever the old
   * `.checkbox-list` div used to go. */
  element: HTMLButtonElement;
  getValues: () => number[];
  /** Sets the checked set programmatically, without firing `onChange` --
   * matches select.ts/colorPicker.ts's own silent `setValue`. */
  setValues: (ids: number[]) => void;
  /** Replaces the offered tags (e.g. once `store.loadTags()` resolves after
   * the trigger was already built with whatever was cached). Selections for
   * ids no longer present are dropped, the way a native multi-select's
   * checked state drops if its `<option>`s are replaced under it. */
  setItems: (items: TagsCheckboxDropdownItem[]) => void;
}

export function createTagsCheckboxDropdown(
  initialItems: TagsCheckboxDropdownItem[],
  initialValues: number[],
  onChange?: (ids: number[]) => void,
  opts: { ariaLabel?: string; emptyMessage?: string } = {},
): TagsCheckboxDropdown {
  let items = [...initialItems];
  let selected = new Set(initialValues);

  const trigger = el("button", { type: "button", class: "custom-select" }) as HTMLButtonElement;
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", opts.ariaLabel ?? "Tags");

  const labelSpan = el("span", { class: "custom-select-label" });
  const chevron = el("span", { class: "custom-select-chevron" });
  chevron.setAttribute("aria-hidden", "true");
  trigger.append(labelSpan, chevron);

  const setLabel = () => {
    labelSpan.textContent = selected.size ? `Tags (${selected.size})` : "Tags";
  };
  setLabel();

  function renderPanel(panel: HTMLElement): void {
    panel.replaceChildren();
    if (!items.length) {
      const empty = el("p", { class: "hint", style: "padding: var(--space-2);" });
      empty.textContent = opts.emptyMessage ?? "No tags exist yet.";
      panel.append(empty);
      return;
    }
    // A full tag list easily runs past a screen's height -- scrolls inside its
    // own capped-height box (like the old `.checkbox-list` this replaces)
    // rather than growing the panel (and the page under it) without bound.
    const list = el("div", { class: "action-menu-checkbox-list" });
    for (const item of items) {
      const row = el("label", { class: "action-menu-item action-menu-checkbox" });
      const checkbox = el("input", { type: "checkbox", value: String(item.id) }) as HTMLInputElement;
      checkbox.checked = selected.has(item.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(item.id);
        else selected.delete(item.id);
        setLabel();
        onChange?.(Array.from(selected));
      });
      row.append(checkbox, document.createTextNode(item.name));
      list.append(row);
    }
    panel.append(list);
  }

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
      ariaLabel: opts.ariaLabel ?? "Tags",
      renderContent: renderPanel,
    });
  });

  return {
    element: trigger,
    getValues: () => Array.from(selected),
    setValues: (ids: number[]) => {
      selected = new Set(ids);
      setLabel();
    },
    setItems: (newItems: TagsCheckboxDropdownItem[]) => {
      items = [...newItems];
      const validIds = new Set(items.map((item) => item.id));
      selected = new Set([...selected].filter((id) => validIds.has(id)));
      setLabel();
      // The panel (if any) was built from the old `items` at open time --
      // rather than reaching into actionMenu.ts for a live panel reference
      // just for this rare race (tags finish loading while the trigger is
      // already open), close it; the next click rebuilds it from the fresh list.
      if (isActionMenuOpenFor(trigger)) closeActionMenu();
    },
  };
}
