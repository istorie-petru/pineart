/**
 * The "Add images" popover — Choose files… / Import a whole folder… — and the
 * hidden file inputs behind it.
 *
 * Uses the shared action-menu component (components/actionMenu.ts, ported
 * from sibling app Curodav's `.action-menu` -- design-system unification
 * pass, 2026-09-18) instead of a bespoke popover: portal-to-body
 * positioning, outside-click/Tab/scroll-closes and keyboard nav all come
 * from there now, so this file is just the two menu items plus the file
 * inputs behind them.
 */

import { qs } from "../ui";
import { toggleActionMenu } from "./actionMenu";

/** Toggles the menu against a given trigger button. Call
 * `event.stopPropagation()` first, or the shared action-menu's own
 * outside-click listener sees the same click and shuts it immediately. */
export function toggleAddImagesMenu(trigger: HTMLElement): void {
  const fileInput = qs<HTMLInputElement>("#uploadInput");
  const folderInput = qs<HTMLInputElement>("#folderInput");
  toggleActionMenu({
    trigger,
    ariaLabel: "Add images",
    sections: [
      {
        items: [
          { label: "Choose files…", action: "files" },
          { label: "Import a whole folder…", action: "folder" },
        ],
      },
    ],
    // Called synchronously from the item's own click handler (which closes the
    // menu, then calls this): browsers only open a file picker during a user
    // gesture, so deferring this (a timeout, an await) would silently do nothing.
    onAction: (action) => {
      if (action === "files") fileInput.click();
      else if (action === "folder") folderInput.click();
    },
  });
}

let wired = false;

/**
 * Wires the shared file inputs' `change` events to `onFiles`. Idempotent and
 * safe to call from every trigger's setup — only the first call actually
 * attaches anything.
 */
export function initAddImages(onFiles: (files: File[]) => void): void {
  if (wired) return;
  wired = true;

  const fileInput = qs<HTMLInputElement>("#uploadInput");
  const folderInput = qs<HTMLInputElement>("#folderInput");

  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    onFiles(files);
  });
  folderInput.addEventListener("change", () => {
    // webkitdirectory hands back every file in the folder, including non-images;
    // filtering here avoids sending obvious junk for the server to reject.
    const files = Array.from(folderInput.files ?? []).filter((f) => f.type.startsWith("image/"));
    folderInput.value = "";
    onFiles(files);
  });
}
