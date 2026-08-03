/**
 * The "Add images" popover — Choose files… / Import a whole folder… — and the
 * hidden file inputs behind it.
 *
 * Extracted out of main.ts so more than one button can trigger it: the
 * topbar's icon (desktop, and mobile when the topbar is visible) and
 * Settings' own "Add images" button (mobile's way in, now that the topbar is
 * hidden there entirely). One menu, one pair of inputs, so adding a new
 * trigger button anywhere is just calling `toggleAddImagesMenu` from its
 * click handler — no new upload plumbing per button.
 */

import { el, isTypingTarget, qs } from "../ui";

let menu: HTMLElement | null = null;
let openTrigger: HTMLElement | null = null;
let wired = false;

function closeMenu(): void {
  menu?.remove();
  menu = null;
  openTrigger?.setAttribute("aria-expanded", "false");
  openTrigger = null;
}

function openMenu(trigger: HTMLElement): void {
  const fileInput = qs<HTMLInputElement>("#uploadInput");
  const folderInput = qs<HTMLInputElement>("#folderInput");
  const popover = el("div", { class: "menu-popover", role: "menu" });

  const entry = (label: string, onPick: () => void) => {
    const button = el("button", { type: "button", role: "menuitem" });
    button.textContent = label;
    button.addEventListener("click", () => {
      closeMenu();
      // Called synchronously inside the click handler: browsers only open a
      // file picker during a user gesture, so deferring this (a timeout, an
      // await) would silently do nothing.
      onPick();
    });
    return button;
  };

  popover.append(
    entry("Choose files…", () => fileInput.click()),
    entry("Import a whole folder…", () => folderInput.click()),
  );

  // Positioned from the trigger's own box rather than a hardcoded offset, so
  // it stays attached wherever that button lives — topbar or a Settings panel.
  const box = trigger.getBoundingClientRect();
  popover.style.top = `${box.bottom + window.scrollY + 6}px`;
  popover.style.right = `${document.documentElement.clientWidth - box.right}px`;

  document.body.append(popover);
  menu = popover;
  openTrigger = trigger;
  trigger.setAttribute("aria-expanded", "true");
}

/** Toggles the menu against a given trigger button. Call
 * `event.stopPropagation()` first, or the document-level close-on-outside-
 * click listener below sees the same click and shuts it immediately. */
export function toggleAddImagesMenu(trigger: HTMLElement): void {
  trigger.setAttribute("aria-haspopup", "menu");
  if (menu && openTrigger === trigger) closeMenu();
  else openMenu(trigger);
}

/**
 * Wires the shared file inputs' `change` events to `onFiles`, and the
 * document-level listeners that close the menu on outside click or Escape.
 * Idempotent and safe to call from every trigger's setup — only the first
 * call actually attaches anything.
 */
export function initAddImages(onFiles: (files: File[]) => void): void {
  if (wired) return;
  wired = true;

  document.addEventListener("click", (event) => {
    if (menu && !menu.contains(event.target as Node)) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !isTypingTarget(event)) closeMenu();
  });

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
