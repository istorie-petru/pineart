/** Small DOM helpers, toasts and the generic modal shell. */

import { icon } from "./icons";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("data-") || key === "style") node.setAttribute(key, value);
    else node.setAttribute(key, value);
  }
  if (html !== undefined) node.innerHTML = html;
  return node;
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

/**
 * True when the event is aimed at somewhere the user is typing.
 *
 * Every keyboard shortcut has to consult this. Without it, typing a title that
 * contains an arrow-key correction jumps to the next image, and "d" in a
 * description would trigger whatever "d" is bound to — the classic way an app
 * becomes unusable the moment you add a second shortcut.
 */
export function isTypingTarget(event: Event): boolean {
  const isField = (node: Element | null): boolean => {
    if (!node) return false;
    const tag = node.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      (node as HTMLElement).isContentEditable === true
    );
  };
  // Both the event target and the focused element are checked. The target alone
  // is not enough: a shortcut bound on `document` can receive an event whose
  // target is the document itself while focus sits in a field, and it would then
  // steal a keystroke meant for the text.
  return isField(event.target as Element | null) || isField(document.activeElement);
}

/**
 * Strip leading and trailing whitespace from anything pasted into a text field.
 *
 * Copying a tag or a title out of another app almost always brings a trailing
 * newline or a stray indent with it, and those survive into the database as
 * invisible differences — a tag named "landscape " that never matches
 * "landscape". Internal line breaks are left alone, so pasting a paragraph into
 * a description still works.
 *
 * `insertText` is used rather than assigning `value` because it keeps the browser's
 * undo history intact; assignment silently discards it, and ctrl-Z after a paste
 * is exactly when someone needs it.
 */
export function installPasteTrimming(): void {
  document.addEventListener("paste", (event: ClipboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const isField =
      target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
    if (!isField) return;

    const raw = event.clipboardData?.getData("text/plain");
    if (raw === undefined) return;
    const trimmed = raw.trim();
    if (trimmed === raw) return; // nothing to do; let the browser handle it

    event.preventDefault();
    if (!document.execCommand("insertText", false, trimmed)) {
      // execCommand is deprecated and may be unavailable; fall back to editing
      // the value directly, accepting the loss of one undo step.
      const field = target as HTMLInputElement | HTMLTextAreaElement;
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      field.value = field.value.slice(0, start) + trimmed + field.value.slice(end);
      const caret = start + trimmed.length;
      field.setSelectionRange(caret, caret);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}

export function toast(
  message: string,
  kind: "info" | "error" = "info",
  action?: { label: string; onClick: () => void },
): void {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const node = el("div", { class: `toast${kind === "error" ? " error" : ""}` });
  node.textContent = message;
  if (action) {
    const button = el("button", { class: "toast-action", type: "button" });
    button.textContent = action.label;
    button.addEventListener("click", () => {
      node.remove();
      action.onClick();
    });
    node.append(button);
  }
  stack.appendChild(node);
  // An action toast (e.g. trash's "Undo") stays up noticeably longer than a
  // plain confirmation — it's not just information, it's a small window of
  // opportunity, and 3s is too short to reliably notice and react to it.
  window.setTimeout(() => node.remove(), kind === "error" ? 6000 : action ? 6000 : 3000);
}

/**
 * Shown/hidden by `main.ts` via `api.setConnectivityHandler` — a fixed banner
 * across the top of the page while the backend is unreachable. Created once
 * and reused rather than per-call, since there's only ever one at a time.
 */
let connectivityBanner: HTMLElement | null = null;

export function setConnectivityBannerVisible(visible: boolean): void {
  if (!connectivityBanner) {
    connectivityBanner = el("div", { class: "connectivity-banner", role: "status" });
    connectivityBanner.textContent =
      "Can't reach the server — checking your connection…";
    document.body.append(connectivityBanner);
  }
  connectivityBanner.classList.toggle("visible", visible);
}

/**
 * A styled error state — consistent with the rest of the app's visual
 * language instead of a raw traceback or a blank white screen the moment
 * something goes wrong (advance.md §5). Used for "board not found", "could
 * not reach the backend" at boot, and as a last-resort catch for an
 * uncaught error elsewhere.
 */
export function renderErrorView(
  root: HTMLElement,
  options: { title: string; message: string; action?: { label: string; onClick: () => void } },
): void {
  const view = el("section", { class: "error-view" });
  view.innerHTML = icon("focus");
  const heading = el("h2");
  heading.textContent = options.title;
  const message = el("p");
  message.textContent = options.message;
  view.append(heading, message);
  if (options.action) {
    const button = el("button", { class: "btn btn-filled" });
    button.textContent = options.action.label;
    button.addEventListener("click", options.action.onClick);
    view.append(button);
  }
  root.replaceChildren(view);
}

/** Wraps an async handler so a failed request surfaces as a toast, not a silent no-op. */
export function guard<T extends unknown[]>(fn: (...args: T) => Promise<void>): (...args: T) => void {
  return (...args: T) => {
    fn(...args).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), "error");
    });
  };
}

/**
 * Returns a runner that executes async callbacks one at a time, in call
 * order, no matter how quickly they're triggered.
 *
 * Built for one specific failure mode: two edits to the same shared in-memory
 * object fired close together — e.g. removing one tag chip and adding
 * another before the first request has come back. Each edit's handler reads
 * the object's *current* state (its full tag list) to build its request body,
 * then overwrites the object with the response when done. Fire them
 * concurrently and whichever response lands second wins outright, silently
 * discarding the other edit — not merging, just gone. Serializing means the
 * second callback's body does not even start running until the first has
 * finished applying its result, so it always reads state the first edit has
 * already updated, rather than a stale snapshot from before it.
 */
export function serialize(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export interface ModalHandle {
  backdrop: HTMLElement;
  body: HTMLElement;
  close: () => void;
}

/**
 * Creates a modal, appends it and returns a handle.
 *
 * Escape and backdrop clicks close it; an `onClose` hook lets callers release
 * resources (the crop modal destroys its Cropper instance there, which
 * otherwise leaks a canvas and its event listeners on every open).
 */
export function openModal(options: {
  className?: string;
  maxWidth?: string;
  onClose?: () => void;
}): ModalHandle {
  const backdrop = el("div", { class: "modal-backdrop active" });
  const modal = el("div", { class: "modal" });
  if (options.maxWidth) modal.style.maxWidth = options.maxWidth;

  const closeBtn = el("button", { class: "close-btn", "aria-label": "Close" }, icon("close"));
  const body = el("div", { class: options.className ?? "simple-modal-body" });
  modal.append(closeBtn, body);
  backdrop.append(modal);
  document.body.append(backdrop);
  // Moves keyboard focus into the modal the instant it opens — otherwise
  // focus stays wherever it was on the page underneath, and Tab from there
  // ignores the modal entirely rather than starting inside it.
  closeBtn.focus();

  const previouslyFocused = document.activeElement as HTMLElement | null;

  const close = () => {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    options.onClose?.();
    // Focus returns to whatever opened the modal rather than resetting to
    // `<body>` — otherwise closing a modal silently drops keyboard focus
    // back to the top of the page for anyone navigating without a mouse.
    previouslyFocused?.focus?.();
  };
  const onKey = (event: KeyboardEvent) => {
    // Escape still closes from a text field — that is the expected way out of a
    // dialog — but only once whatever is being edited has had its chance to
    // handle it first, which inline editors do by stopping propagation.
    if (event.key === "Escape") {
      close();
      return;
    }
    // Focus trapping: while the modal is open, Tab/Shift+Tab cycles only
    // through its own focusable elements instead of leaking out to the grid
    // (or whatever else) behind it — a modal that lets keyboard focus escape
    // to what it's covering is a modal that isn't really modal.
    if (event.key === "Tab") {
      const focusable = Array.from(
        modal.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!modal.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  // A plain `click` listener is not enough: browsers fire `click` on the
  // nearest common ancestor of the mousedown and mouseup targets, not just on
  // wherever the pointer happened to lift. Dragging a Cropper.js handle (or
  // any drag that starts inside the modal) and releasing over the backdrop
  // therefore produced a `click` whose target *was* the backdrop, closing the
  // modal out from under a resize the user never meant to end. Requiring the
  // mousedown to have also started on the backdrop itself fixes that: only an
  // actual click on empty backdrop, not a drag that merely ends there, closes it.
  let downOnBackdrop = false;
  backdrop.addEventListener("mousedown", (event) => {
    downOnBackdrop = event.target === backdrop;
  });
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop && downOnBackdrop) close();
  });
  document.addEventListener("keydown", onKey);

  return { backdrop, body, close };
}

export function confirmDialog(message: string, confirmLabel = "Confirm"): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      maxWidth: "400px",
      onClose: () => {
        if (!settled) resolve(false);
      },
    });
    const text = el("p", { class: "hint" });
    text.textContent = message;
    const row = el("div", { style: "display:flex; gap:10px; margin-top:18px;" });
    const cancel = el("button", { class: "btn btn-outlined", style: "flex:1; justify-content:center;" });
    cancel.textContent = "Cancel";
    const confirm = el("button", { class: "btn btn-error-tonal", style: "flex:1; justify-content:center;" });
    confirm.textContent = confirmLabel;
    row.append(cancel, confirm);
    modal.body.append(text, row);

    cancel.addEventListener("click", () => modal.close());
    confirm.addEventListener("click", () => {
      settled = true;
      resolve(true);
      modal.close();
    });
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean.padEnd(6, "0").slice(0, 6);
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}

/** sRGB (0-255) channel to linear light (0-1) — the de-gamma step WCAG's
 * relative luminance formula is defined over. */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear light (0-1) back to an sRGB (0-255) channel, clamped. */
function linearToSrgb(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v * 255;
}

/**
 * Darkens (or, for a near-black input, lightens) a colour just enough that
 * white text drawn on top of it — which every tag chip and graph node label
 * does, in both themes — stays legible, while leaving its hue alone.
 *
 * The first version of this clamped HSL "lightness" into a band per theme,
 * which was the wrong axis: HSL lightness does not track perceived
 * brightness across hues, so a stored yellow at, say, 66% lightness clamped
 * down to 62% and was *still* a bright yellow — white text on it stayed
 * unreadable, in either theme, because 62%-lightness yellow and 62%-lightness
 * blue are nowhere near equally bright to the eye. WCAG relative luminance is
 * the formula that actually accounts for that (it weights green highest, blue
 * lowest, matching human perception), so this works in luminance instead: if
 * a colour's luminance is above what keeps white text readable, every
 * channel is scaled down together *in linear light* — which dims without
 * shifting hue — until it drops back into a safe band. A colour already dark
 * enough to blend into a near-black page gets nudged the other way, off a
 * true-black floor, so it still reads as a distinct swatch there too. Because
 * the chip text is white regardless of theme, this same band is correct for
 * both — no need to key it off `data-theme` at all.
 */
export function contrastSafeColor(hex: string): string {
  let clean = hex.trim();
  if (!/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(clean)) return hex;
  if (!clean.startsWith("#")) clean = `#${clean}`;
  const [r, g, b] = hexToRgb(clean);

  const linR = srgbToLinear(r);
  const linG = srgbToLinear(g);
  const linB = srgbToLinear(b);
  const luminance = 0.2126 * linR + 0.7152 * linG + 0.0722 * linB;

  // 0.16 keeps white text at roughly 5:1 contrast (comfortably past the 4.5:1
  // AA threshold for normal-size text, which is what chip labels are). 0.035
  // is just enough above the dark theme's own near-black background (~0.01)
  // that a very dark stored colour still reads as "a colour" against it.
  const MAX_LUMINANCE = 0.16;
  const MIN_LUMINANCE = 0.035;

  let scale = 1;
  if (luminance > MAX_LUMINANCE) scale = MAX_LUMINANCE / Math.max(luminance, 1e-6);
  else if (luminance > 0 && luminance < MIN_LUMINANCE) scale = MIN_LUMINANCE / luminance;
  if (scale === 1) return rgbToHex(r, g, b);

  return rgbToHex(linearToSrgb(linR * scale), linearToSrgb(linG * scale), linearToSrgb(linB * scale));
}

/**
 * A tag's displayed colour: its own colour if set, else its supercategory's
 * colour, else a deterministic per-id fallback — run through
 * `contrastSafeColor` so whichever of those it resolves to still holds up
 * against the theme actually on screen.
 *
 * The per-id fallback is keyed on the tag id so an uncategorized tag keeps the
 * same colour across reloads and across the grid, modal and graph — a random
 * colour per render would make the graph unreadable between visits. A
 * category's colour is checked before that fallback so recolouring a category
 * (or filing a tag under one) is what actually changes what the tag looks
 * like everywhere, rather than every tag needing its own colour picked by hand.
 */
export function tagColor(tag: { id: number; color: string | null; category?: { color: string } | null }): string {
  const palette = ["#457b9d", "#2a9d8f", "#6d597a", "#e9c46a", "#b56576", "#588157", "#219ebc", "#d62828"];
  const raw = tag.color || tag.category?.color || palette[tag.id % palette.length];
  return contrastSafeColor(raw);
}
