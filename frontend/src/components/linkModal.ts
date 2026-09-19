/** Create/edit a link's details — title, URL, group and icon. The Links page
 * (views/links.ts) is where links are listed and where the preview image is
 * uploaded; this modal only covers the text fields. */

import { api } from "../api";
import { DECORATIVE_ICON_KEYS } from "../icons";
import type { Link } from "../types";
import { appendModalActions, confirmDialog, el, guard, guardForm, openModal, toast } from "../ui";
import { createIconPicker } from "./iconPicker";

export function openLinkModal(link: Link | null, onSaved: () => void): void {
  const modal = openModal({
    className: "link-modal-body",
    maxWidth: "400px",
    title: link ? "Edit link" : "Add link",
  });

  const nameLabel = el("label");
  nameLabel.textContent = "Name";
  const nameInput = el("input", { type: "text", name: "title", placeholder: "e.g. ArtStation" }) as HTMLInputElement;
  nameInput.value = link?.title ?? "";

  const urlLabel = el("label");
  urlLabel.textContent = "URL";
  const urlInput = el("input", { type: "text", name: "url", placeholder: "https://…" }) as HTMLInputElement;
  urlInput.value = link?.url ?? "";

  const groupLabel = el("label");
  groupLabel.textContent = "Group";
  const groupInput = el("input", {
    type: "text",
    name: "group",
    placeholder: "e.g. Shops (optional)",
  }) as HTMLInputElement;
  groupInput.value = link?.group_name ?? "";

  const iconLabel = el("label");
  iconLabel.textContent = "Icon";
  const iconPicker = createIconPicker(DECORATIVE_ICON_KEYS, link?.icon ?? "globe", undefined, { ariaLabel: "Icon" });

  const save = el("button", { class: "btn btn-filled" }) as HTMLButtonElement;
  save.textContent = "Save";

  let remove: HTMLElement | undefined;
  if (link) {
    remove = el("button", { class: "delete-link", type: "button" });
    remove.textContent = "Delete link";
    remove.addEventListener(
      "click",
      guard(async () => {
        if (!(await confirmDialog(`Delete the "${link.title}" link?`, "Delete"))) return;
        await api.deleteLink(link.id);
        modal.close();
        onSaved();
      }),
    );
  }

  modal.body.append(nameLabel, nameInput, urlLabel, urlInput, groupLabel, groupInput, iconLabel, iconPicker.element);
  appendModalActions(modal, save, remove);

  save.addEventListener(
    "click",
    guardForm(modal.body, async () => {
      const title = nameInput.value.trim();
      let url = urlInput.value.trim();
      if (!title || !url) {
        toast("Name and URL are both required", "error");
        return;
      }
      // The backend requires an explicit scheme; adding https:// here is
      // friendlier than bouncing a 422 back at someone who typed a bare domain.
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

      save.disabled = true;
      const chosenIcon = iconPicker.get() ?? "globe";
      const group_name = groupInput.value.trim() || null;
      try {
        if (link) await api.patchLink(link.id, { title, url, icon: chosenIcon, group_name });
        else await api.createLink({ title, url, icon: chosenIcon, group_name });
        modal.close();
        onSaved();
      } finally {
        save.disabled = false;
      }
    }),
  );

  nameInput.focus();
}
