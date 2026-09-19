/**
 * Add a saved search template for Discovery — same one-modal-per-entity shape
 * as categoryModal.ts/graphRuleModal.ts, replacing the inline name+pattern+Save
 * row settings.ts used to render directly in the panel.
 */

import { appendModalActions, el, guardForm, openModal, toast } from "../ui";

export function openSearchTemplateModal(onSaved: (name: string, template: string) => Promise<void>): void {
  const modal = openModal({ className: "simple-modal-body", maxWidth: "420px", title: "Add search template" });

  const nameLabel = el("label");
  nameLabel.textContent = "Name";
  const nameInput = el("input", { type: "text", name: "name", placeholder: "e.g. High-res only" }) as HTMLInputElement;

  const templateLabel = el("label");
  templateLabel.textContent = "Template";
  const templateInput = el("input", {
    type: "text",
    name: "template",
    placeholder: "{query} artwork",
  }) as HTMLInputElement;

  const hint = el("p", { class: "hint", style: "margin-top:8px;" });
  hint.textContent = "Use {query} where your search terms should go, e.g. \"{query} high resolution\".";

  const save = el("button", { class: "btn btn-filled" }) as HTMLButtonElement;
  save.textContent = "Save";

  modal.body.append(nameLabel, nameInput, templateLabel, templateInput, hint);
  appendModalActions(modal, save);

  save.addEventListener(
    "click",
    guardForm(modal.body, async () => {
      const name = nameInput.value.trim();
      const template = templateInput.value.trim();
      if (!name || !template) {
        toast("A template needs a name and a pattern", "error");
        return;
      }
      if (!template.includes("{query}")) {
        toast("The template must contain {query}", "error");
        return;
      }
      save.disabled = true;
      try {
        await onSaved(name, template);
        modal.close();
      } finally {
        save.disabled = false;
      }
    }),
  );
}
