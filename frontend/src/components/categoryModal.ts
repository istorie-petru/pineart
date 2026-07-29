/**
 * Create/edit a tag supercategory. Mirrors linkModal.ts: one modal handles both
 * add and edit, with a Delete button appearing only when editing an existing
 * category. Kept as a modal rather than an inline sidebar form because the
 * sidebar is narrow — name, color, and the links toggle together don't fit one
 * row without wrapping awkwardly.
 */

import { api } from "../api";
import type { TagCategory } from "../types";
import { confirmDialog, el, guard, openModal, toast } from "../ui";

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

  const save = el("button", {
    class: "btn btn-filled",
    style: "margin-top:18px; width:100%; justify-content:center;",
  }) as HTMLButtonElement;
  save.textContent = "Save";

  modal.body.append(heading, nameLabel, nameInput, colorLabel, colorInput, linksLabel, save);

  if (category) {
    const remove = el("button", {
      class: "btn btn-error-tonal",
      style: "margin-top:10px; width:100%; justify-content:center;",
    });
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
    modal.body.append(remove);
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
      try {
        if (category) {
          await api.patchTagCategory(category.id, {
            name,
            color: colorInput.value,
            links_enabled: linksCheckbox.checked,
          });
        } else {
          await api.createTagCategory(name, colorInput.value, linksCheckbox.checked);
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
