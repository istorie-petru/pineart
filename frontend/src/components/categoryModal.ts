/**
 * Create/edit a tag supercategory. Mirrors linkModal.ts: one modal handles both
 * add and edit, with a Delete button appearing only when editing an existing
 * category. Kept as a modal rather than an inline sidebar form because the
 * sidebar is narrow — name, color, and the links toggle together don't fit one
 * row without wrapping awkwardly.
 */

import { api } from "../api";
import { DECORATIVE_ICON_KEYS } from "../icons";
import type { TagCategory } from "../types";
import { appendModalActions, confirmDialog, el, guard, guardForm, openModal, toast, toggleSwitch } from "../ui";
import { createColorPicker } from "./colorPicker";
import { createIconPicker } from "./iconPicker";

export function openCategoryModal(category: TagCategory | null, onSaved: () => void): void {
  const modal = openModal({
    className: "simple-modal-body",
    maxWidth: "380px",
    title: category ? "Edit category" : "Add category",
  });

  const nameLabel = el("label");
  nameLabel.textContent = "Name";
  const nameInput = el("input", { type: "text", name: "name", placeholder: "e.g. Character" }) as HTMLInputElement;
  nameInput.value = category?.name ?? "";

  // Color + icon grouped side-by-side -- both are "appearance" choices,
  // deliberately the LAST fields (direct feedback, 2026-09-19: "color and
  // icons should always be at the end of the list"), after Name (identity)
  // and the Links toggle (behavior). Matches Curodav's own label-edit modal
  // in grouping color/icon together, though Curodav places that pair higher
  // up -- ordering here follows the more recent direct instruction instead.
  const appearanceRow = el("div", { class: "field-grid", style: "margin-top:14px;" });
  const colorCol = el("div");
  const colorLabel = el("label");
  colorLabel.textContent = "Color";
  const colorPicker = createColorPicker(category?.color ?? "#457b9d", undefined, "Color");
  colorCol.append(colorLabel, colorPicker.element);
  const iconCol = el("div");
  const iconLabel = el("label");
  iconLabel.textContent = "Icon";
  // The default icon for every tag filed under this category — a tag with
  // an icon of its own still wins (see ui.ts's tagIconKey).
  const iconPicker = createIconPicker(DECORATIVE_ICON_KEYS, category?.icon, undefined, {
    allowNone: true,
    ariaLabel: "Icon",
  });
  iconCol.append(iconLabel, iconPicker.element);
  appearanceRow.append(colorCol, iconCol);

  // Not an outer <label> wrapping the switch's own <label class="switch">
  // -- nested labels are invalid HTML and can double-toggle the input in
  // some browsers. The switch itself is still a full click target.
  const linksRow = el("div", {
    style: "display:flex; align-items:center; gap:8px; font-size:13px; margin-top:14px;",
  });
  const links = toggleSwitch(category?.links_enabled ?? false, undefined, "Tags can link out");
  const linksText = el("span");
  linksText.textContent = "Tags can link out (e.g. creator profiles)";
  linksRow.append(links.element, linksText);

  const save = el("button", { class: "btn btn-filled" }) as HTMLButtonElement;
  save.textContent = "Save";

  let remove: HTMLElement | undefined;
  if (category) {
    remove = el("button", { class: "delete-link", type: "button" });
    remove.textContent = "Delete category";
    remove.addEventListener(
      "click",
      guard(async () => {
        if (
          !(await confirmDialog(
            `Delete "${category.name}"? Tags under it become uncategorized — they are not deleted.`,
            "Delete",
          ))
        ) {
          return;
        }
        await api.deleteTagCategory(category.id);
        modal.close();
        onSaved();
      }),
    );
  }

  modal.body.append(nameLabel, nameInput, linksRow, appearanceRow);
  appendModalActions(modal, save, remove);

  save.addEventListener(
    "click",
    guardForm(modal.body, async () => {
      const name = nameInput.value.trim();
      if (!name) {
        toast("Name is required", "error");
        return;
      }
      save.disabled = true;
      const chosenIcon = iconPicker.get();
      try {
        if (category) {
          await api.patchTagCategory(category.id, {
            name,
            color: colorPicker.getValue(),
            links_enabled: links.input.checked,
            icon: chosenIcon,
          });
        } else {
          await api.createTagCategory(name, colorPicker.getValue(), links.input.checked, chosenIcon);
        }
        modal.close();
        onSaved();
      } finally {
        save.disabled = false;
      }
    }),
  );

  nameInput.focus();
}
