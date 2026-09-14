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
import { buildIconPicker, confirmDialog, el, guard, openModal, toast } from "../ui";

export function openCategoryModal(category: TagCategory | null, onSaved: () => void): void {
  const modal = openModal({ className: "simple-modal-body", maxWidth: "380px" });

  const heading = el("h3");
  heading.textContent = category ? "Edit category" : "Add category";

  const nameLabel = el("label");
  nameLabel.textContent = "Name";
  const nameInput = el("input", { type: "text", placeholder: "e.g. Character" }) as HTMLInputElement;
  nameInput.value = category?.name ?? "";

  const colorLabel = el("label");
  colorLabel.textContent = "Color";
  const colorInput = el("input", { type: "color" }) as HTMLInputElement;
  colorInput.value = category?.color ?? "#457b9d";

  const linksLabel = el("label", {
    style: "display:flex; align-items:center; gap:6px; font-size:13px; margin-top:14px;",
  });
  const linksCheckbox = el("input", { type: "checkbox" }) as HTMLInputElement;
  linksCheckbox.checked = category?.links_enabled ?? false;
  linksLabel.append(linksCheckbox, "Tags can link out (e.g. creator profiles)");

  // The default icon for every tag filed under this category — a tag with
  // an icon of its own still wins (see ui.ts's tagIconKey).
  const iconLabel = el("label", { style: "margin-top:14px;" });
  iconLabel.textContent = "Icon (default for tags in this category)";
  const iconPicker = buildIconPicker(DECORATIVE_ICON_KEYS, category?.icon, { allowNone: true });

  const save = el("button", { class: "btn btn-filled", style: "justify-content:center;" }) as HTMLButtonElement;
  save.textContent = "Save";
  const actions = el("div", { class: "actions actions-column" });
  actions.append(save);

  modal.body.append(
    heading,
    nameLabel,
    nameInput,
    colorLabel,
    colorInput,
    linksLabel,
    iconLabel,
    iconPicker.element,
    actions,
  );

  if (category) {
    const remove = el("button", { class: "btn btn-error-tonal", style: "justify-content:center;" });
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
    actions.append(remove);
  }

  save.addEventListener(
    "click",
    guard(async () => {
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
            color: colorInput.value,
            links_enabled: linksCheckbox.checked,
            icon: chosenIcon,
          });
        } else {
          await api.createTagCategory(name, colorInput.value, linksCheckbox.checked, chosenIcon);
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
