/**
 * Create/edit a graph-suppression rule. Same shape as categoryModal.ts and
 * linkModal.ts: one modal for both add and edit, Delete only when editing.
 *
 * Needs at least three categories to mean anything (from/to/via must all
 * differ) — the caller is responsible for not opening this until there are
 * that many.
 */

import { api } from "../api";
import { createSelect, type CustomSelect } from "./select";
import type { TagCategory, TagGraphRule } from "../types";
import { appendModalActions, confirmDialog, el, guard, guardForm, openModal, toast } from "../ui";

function categoryField(
  labelText: string,
  categories: TagCategory[],
  selectedId: number | undefined,
  fieldName: string,
): { row: HTMLElement; select: CustomSelect } {
  const label = el("label");
  label.textContent = labelText;
  const select = createSelect(
    categories.map((category) => ({ value: String(category.id), label: category.name })),
    selectedId !== undefined ? String(selectedId) : String(categories[0]?.id ?? ""),
    undefined,
    { ariaLabel: labelText, name: fieldName },
  );
  const row = el("div");
  row.append(label, select.element);
  return { row, select };
}

export function openGraphRuleModal(
  rule: TagGraphRule | null,
  categories: TagCategory[],
  onSaved: () => void,
): void {
  const modal = openModal({
    className: "simple-modal-body",
    maxWidth: "420px",
    title: rule ? "Edit rule" : "Add rule",
  });

  const nameLabel = el("label");
  nameLabel.textContent = "Name (optional)";
  const nameInput = el("input", {
    type: "text",
    name: "name",
    placeholder: "e.g. Hide Category→Character",
  }) as HTMLInputElement;
  // A rule saved with no name shows a composed one ("Anime ✕ Hinata via
  // Haikyu") — start the field blank rather than pre-filling that computed
  // text, or every edit would either keep retyping it or accidentally freeze
  // it as a literal name.
  nameInput.value = rule && rule.name.includes(" ✕ ") && rule.name.includes(" via ") ? "" : rule?.name ?? "";

  const from = categoryField("Don’t connect", categories, rule?.from_category.id, "from_category_id");
  const to = categoryField("to", categories, rule?.to_category.id, "to_category_id");
  const via = categoryField("when connected via", categories, rule?.via_category.id, "via_category_id");

  const hint = el("p", { class: "hint", style: "margin:10px 0;" });
  hint.textContent =
    "Hides the direct edge between the first two categories whenever a tag also connects through the third.";

  const save = el("button", { class: "btn btn-filled" }) as HTMLButtonElement;
  save.textContent = "Save";

  let remove: HTMLElement | undefined;
  if (rule) {
    remove = el("button", { class: "delete-link", type: "button" });
    remove.textContent = "Delete rule";
    remove.addEventListener(
      "click",
      guard(async () => {
        if (!(await confirmDialog("Delete this rule?", "Delete"))) return;
        await api.deleteGraphRule(rule.id);
        modal.close();
        onSaved();
      }),
    );
  }

  modal.body.append(nameLabel, nameInput, from.row, to.row, via.row, hint);
  appendModalActions(modal, save, remove);

  save.addEventListener(
    "click",
    guardForm(modal.body, async () => {
      const fromId = Number(from.select.getValue());
      const toId = Number(to.select.getValue());
      const viaId = Number(via.select.getValue());
      if (fromId === toId || fromId === viaId || toId === viaId) {
        toast("Pick three different categories", "error");
        return;
      }
      // Sent as an explicit string, not `undefined` — clearing the field on an
      // existing rule has to actually clear the stored name (reverting to the
      // composed default), not be silently dropped from the request the way
      // an omitted key would be.
      const name = nameInput.value.trim();
      save.disabled = true;
      try {
        if (rule) {
          await api.patchGraphRule(rule.id, {
            name,
            from_category_id: fromId,
            to_category_id: toId,
            via_category_id: viaId,
          });
        } else {
          await api.createGraphRule(fromId, toId, viaId, name);
        }
        modal.close();
        onSaved();
      } finally {
        save.disabled = false;
      }
    }),
  );
}
