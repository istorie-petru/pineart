/** Create a board — manual, or dynamic with a saved tag query. */

import { api } from "../api";
import { store } from "../store";
import { createSelect } from "./select";
import { createTagsCheckboxDropdown } from "./tagsCheckboxDropdown";
import { appendModalActions, el, guardForm, openModal, toast, toggleSwitch } from "../ui";

export function openBoardCreateModal(onCreated: () => void): void {
  const modal = openModal({ maxWidth: "420px", title: "New board" });

  const nameLabel = el("label");
  nameLabel.textContent = "Name";
  const nameInput = el("input", {
    type: "text",
    name: "name",
    placeholder: "e.g. Studies & Palettes",
  }) as HTMLInputElement;

  const descLabel = el("label");
  descLabel.textContent = "Description";
  const descInput = el("textarea", { name: "description", rows: "2" }) as HTMLTextAreaElement;

  const dynamicRow = el("div", { class: "field-row", style: "margin-top:14px;" });
  const dynamicLabel = el("span");
  dynamicLabel.textContent = "Saved-search board";
  const dynamicSwitch = toggleSwitch(false, undefined, "Saved-search board");
  const dynamicToggle = dynamicSwitch.input;
  dynamicRow.append(dynamicLabel, dynamicSwitch.element);

  const dynamicHint = el("p", { class: "hint" });
  dynamicHint.textContent =
    "A saved-search board has no fixed contents: it always shows every item carrying the tags you pick, and updates itself as you tag things.";

  const queryBlock = el("div");
  queryBlock.hidden = true;
  const modeLabel = el("label");
  modeLabel.textContent = "Match";
  const modeSelect = createSelect(
    [
      { value: "any", label: "Any of these tags (OR)" },
      { value: "all", label: "All of these tags (AND)" },
    ],
    "any",
    undefined,
    { ariaLabel: "Match" },
  );
  const tagsLabel = el("label");
  tagsLabel.textContent = "Tags";
  const tagsDropdown = createTagsCheckboxDropdown(
    store.tags.map((tag) => ({ id: tag.id, name: tag.name })),
    [],
    undefined,
    { emptyMessage: "No tags exist yet, so a saved-search board would be empty." },
  );
  queryBlock.append(modeLabel, modeSelect.element, tagsLabel, tagsDropdown.element);

  dynamicToggle.addEventListener("change", () => {
    queryBlock.hidden = !dynamicToggle.checked;
  });

  const create = el("button", { class: "btn btn-filled" }) as HTMLButtonElement;
  create.textContent = "Create board";

  modal.body.append(nameLabel, nameInput, descLabel, descInput, dynamicRow, dynamicHint, queryBlock);
  appendModalActions(modal, create);
  nameInput.focus();

  void store.loadTags().then(() => {
    tagsDropdown.setItems(store.tags.map((tag) => ({ id: tag.id, name: tag.name })));
  });

  create.addEventListener(
    "click",
    guardForm(modal.body, async () => {
      const name = nameInput.value.trim();
      if (!name) {
        toast("A board needs a name", "error");
        return;
      }
      const isDynamic = dynamicToggle.checked;
      const tagIds = tagsDropdown.getValues();
      if (isDynamic && !tagIds.length) {
        toast("Pick at least one tag — a saved-search board with no tags matches nothing", "error");
        return;
      }

      create.disabled = true;
      try {
        await api.createBoard({
          name,
          description: descInput.value.trim() || null,
          is_dynamic: isDynamic,
          query_tags: isDynamic
            ? tagIds.map((id) => ({ tag_id: id, match_mode: modeSelect.getValue() as "all" | "any" }))
            : [],
        });
        modal.close();
        onCreated();
        toast("Board created");
      } finally {
        create.disabled = false;
      }
    }),
  );
}
