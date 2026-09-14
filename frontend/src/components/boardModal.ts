/** Create a board — manual, or dynamic with a saved tag query. */

import { api } from "../api";
import { store } from "../store";
import { el, guard, openModal, toast } from "../ui";

export function openBoardCreateModal(onCreated: () => void): void {
  const modal = openModal({ maxWidth: "420px" });

  const heading = el("h3");
  heading.textContent = "New board";

  const nameLabel = el("label");
  nameLabel.textContent = "Name";
  const nameInput = el("input", { type: "text", placeholder: "e.g. Studies & Palettes" }) as HTMLInputElement;

  const descLabel = el("label");
  descLabel.textContent = "Description";
  const descInput = el("textarea", { rows: "2" }) as HTMLTextAreaElement;

  const dynamicRow = el("div", { class: "field-row", style: "margin-top:14px;" });
  const dynamicLabel = el("span");
  dynamicLabel.textContent = "Saved-search board";
  const dynamicToggle = el("input", { type: "checkbox" }) as HTMLInputElement;
  dynamicRow.append(dynamicLabel, dynamicToggle);

  const dynamicHint = el("p", { class: "hint" });
  dynamicHint.textContent =
    "A saved-search board has no fixed contents: it always shows every item carrying the tags you pick, and updates itself as you tag things.";

  const queryBlock = el("div");
  queryBlock.hidden = true;
  const modeLabel = el("label");
  modeLabel.textContent = "Match";
  const modeSelect = el("select") as HTMLSelectElement;
  for (const [value, label] of [
    ["any", "Any of these tags (OR)"],
    ["all", "All of these tags (AND)"],
  ]) {
    const option = el("option", { value }) as HTMLOptionElement;
    option.textContent = label;
    modeSelect.append(option);
  }
  const tagsLabel = el("label");
  tagsLabel.textContent = "Tags";
  const tagList = el("div", { class: "checkbox-list" });
  queryBlock.append(modeLabel, modeSelect, tagsLabel, tagList);

  dynamicToggle.addEventListener("change", () => {
    queryBlock.hidden = !dynamicToggle.checked;
  });

  const create = el("button", { class: "btn btn-filled", style: "justify-content:center;" }) as HTMLButtonElement;
  create.textContent = "Create board";
  const actions = el("div", { class: "actions actions-column" });
  actions.append(create);

  modal.body.append(
    heading,
    nameLabel,
    nameInput,
    descLabel,
    descInput,
    dynamicRow,
    dynamicHint,
    queryBlock,
    actions,
  );
  nameInput.focus();

  void store.loadTags().then(() => {
    if (!store.tags.length) {
      const empty = el("p", { class: "hint" });
      empty.textContent = "No tags exist yet, so a saved-search board would be empty.";
      tagList.append(empty);
      return;
    }
    for (const tag of store.tags) {
      const label = el("label");
      const checkbox = el("input", { type: "checkbox", value: String(tag.id) }) as HTMLInputElement;
      label.append(checkbox, document.createTextNode(tag.name));
      tagList.append(label);
    }
  });

  create.addEventListener(
    "click",
    guard(async () => {
      const name = nameInput.value.trim();
      if (!name) {
        toast("A board needs a name", "error");
        return;
      }
      const isDynamic = dynamicToggle.checked;
      const matchMode = modeSelect.value as "all" | "any";
      const tagIds = Array.from(
        tagList.querySelectorAll<HTMLInputElement>("input:checked"),
        (input) => Number(input.value),
      );
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
          query_tags: isDynamic ? tagIds.map((id) => ({ tag_id: id, match_mode: matchMode })) : [],
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
