/** Create/edit a link pill. There is no list view — this modal is the link UI. */

import { api } from "../api";
import { icon, LINK_ICON_KEYS } from "../icons";
import type { Link } from "../types";
import { confirmDialog, el, guard, openModal, toast } from "../ui";

export function openLinkModal(link: Link | null, onSaved: () => void): void {
  const modal = openModal({ className: "link-modal-body", maxWidth: "400px" });

  const heading = el("h3");
  heading.textContent = link ? "Edit link" : "Add link";

  const nameLabel = el("label");
  nameLabel.textContent = "Name";
  const nameInput = el("input", { type: "text", placeholder: "e.g. ArtStation" }) as HTMLInputElement;
  nameInput.value = link?.title ?? "";

  const urlLabel = el("label");
  urlLabel.textContent = "URL";
  const urlInput = el("input", { type: "text", placeholder: "https://…" }) as HTMLInputElement;
  urlInput.value = link?.url ?? "";

  const iconLabel = el("label");
  iconLabel.textContent = "Icon";
  const picker = el("div", { class: "icon-picker" });
  let chosenIcon = link?.icon ?? "globe";
  for (const key of LINK_ICON_KEYS) {
    const button = el("button", { type: "button", title: key }, icon(key, true));
    button.classList.toggle("selected", key === chosenIcon);
    button.addEventListener("click", () => {
      chosenIcon = key;
      picker.querySelectorAll("button").forEach((b) => b.classList.remove("selected"));
      button.classList.add("selected");
    });
    picker.append(button);
  }

  const save = el("button", {
    class: "btn btn-filled",
    style: "margin-top:18px; width:100%; justify-content:center;",
  }) as HTMLButtonElement;
  save.textContent = "Save";

  modal.body.append(heading, nameLabel, nameInput, urlLabel, urlInput, iconLabel, picker, save);

  if (link) {
    const remove = el("button", {
      class: "btn btn-error-tonal",
      style: "margin-top:10px; width:100%; justify-content:center;",
    });
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
    modal.body.append(remove);
  }

  save.addEventListener(
    "click",
    guard(async () => {
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
      try {
        if (link) await api.patchLink(link.id, { title, url, icon: chosenIcon });
        else await api.createLink({ title, url, icon: chosenIcon });
        modal.close();
        onSaved();
      } finally {
        save.disabled = false;
      }
    }),
  );

  nameInput.focus();
}
