/** Small DOM helpers, toasts and the generic modal shell. */

import { ApiError } from "./api";
import { icon } from "./icons";
import { TAG_PALETTE } from "./palette";

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
 * The plain "nothing here yet" empty-state message (design-system
 * unification pass, 2026-09-17) -- one function for the `.empty-msg`
 * markup, used by both Grid's own built-in empty state (boards.ts's item
 * search, boardDetail.ts, settings.ts's trash) and feed.ts's hand-rolled
 * status line (Discover isn't Grid-backed, so it manages its own show/
 * hide text directly, but the visual result should still be the same one
 * pattern, not two independently-typed copies of the class name).
 */
export function emptyStateMessage(text: string): HTMLElement {
  const message = el("p", { class: "empty-msg" });
  message.textContent = text;
  return message;
}

/**
 * A slide toggle for a single boolean preference (design-system unification
 * pass, 2026-09-18, ported from sibling app Curodav's own `.switch`) --
 * builds the `<label class="switch"><input type="checkbox">...<span
 * class="slider"></span></label>` structure styles.css's `.switch` rules
 * expect, so every call site swaps a hand-rolled checkbox for one call here
 * instead of repeating the three-element structure. Not for a list of many
 * checkboxes to select from (bulk tag selection, etc.) -- those stay plain
 * checkboxes, same as Curodav's own `.switch` is scoped to "app
 * preferences" only, never a selection list.
 */
export function toggleSwitch(
  checked: boolean,
  onChange?: (checked: boolean) => void,
  ariaLabel?: string,
): { element: HTMLLabelElement; input: HTMLInputElement } {
  const input = el("input", { type: "checkbox" }) as HTMLInputElement;
  input.checked = checked;
  if (ariaLabel) input.setAttribute("aria-label", ariaLabel);
  if (onChange) input.addEventListener("change", () => onChange(input.checked));
  const element = el("label", { class: "switch" });
  element.append(input, el("span", { class: "slider" }));
  return { element, input };
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
 * Clears a prior applyFieldErrors() pass — called at the top of every
 * submit attempt, not just on success, so a fixed field doesn't keep
 * showing a stale error after a second try.
 */
export function clearFieldErrors(container: HTMLElement): void {
  container.querySelectorAll(".has-error").forEach((node) => node.classList.remove("has-error"));
  container.querySelectorAll(".field-error").forEach((node) => node.remove());
}

/**
 * Marks a 422's per-field errors against the actual input inside
 * `container` (design-system unification pass, 2026-09-17, shared spec at
 * /home/peter/Claude/Projects/DESIGN_SYSTEM.md — same pattern as sibling
 * app Curodav's modal.js::applyFieldErrors). Matches by the error's last
 * `loc` segment against an input's `name` attribute — the handful of
 * inputs in entity-form modals that participate in validation (name,
 * description, url, ...) now carry one for exactly this purpose; nothing
 * else in this hand-built-DOM app relies on `name` for anything. Returns
 * the messages that had no matching input, for the caller to still toast.
 */
export function applyFieldErrors(container: HTMLElement, error: ApiError): string[] {
  clearFieldErrors(container);
  const unmatched: string[] = [];
  let firstInvalid: HTMLElement | null = null;
  for (const d of error.fieldErrors) {
    const fieldName = d.loc.length ? String(d.loc[d.loc.length - 1]) : null;
    const input = fieldName ? container.querySelector<HTMLElement>(`[name="${CSS.escape(fieldName)}"]`) : null;
    if (!input) {
      unmatched.push(fieldName ? `${fieldName}: ${d.msg}` : d.msg);
      continue;
    }
    input.classList.add("has-error");
    const hint = el("span", { class: "field-error" });
    hint.textContent = d.msg;
    input.insertAdjacentElement("afterend", hint);
    if (!firstInvalid) firstInvalid = input;
  }
  firstInvalid?.focus();
  return unmatched;
}

/**
 * Like guard(), but for a modal's primary-action handler specifically: an
 * ApiError carrying structured field errors gets marked inline via
 * applyFieldErrors instead of only ever showing a toast with no way to
 * tell which field is wrong. Anything unmatched (or any non-validation
 * error) still falls back to the plain toast, unchanged from guard().
 */
export function guardForm(container: HTMLElement, fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((error: unknown) => {
      if (error instanceof ApiError && error.fieldErrors.length) {
        const unmatched = applyFieldErrors(container, error);
        if (unmatched.length) toast(unmatched.join("; "), "error");
        return;
      }
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
  /** Flex-column wrapper around `header`/`body`/`footer` -- `.modal`'s own
   * actual flex child. Exists so `.modal`'s base `display:flex` (row
   * direction, relied on by itemModal.ts's separate img-pane/info-pane
   * layout) never has to change: this wrapper is additive, not a change to
   * `.modal` itself. Callers that tear down the default body (itemModal.ts)
   * need to remove this instead of `body` directly, or an empty wrapper is
   * left behind squeezing the row layout. */
  content: HTMLElement;
  /** Only present when `openModal()` was called with `title` or
   * `customHeader` -- a plain-title caller gets an auto-built `<h3>` inside;
   * a `customHeader`-only caller gets an empty div to build its own richer
   * header into (title + subtitle, etc). Neither flag set -- no header at
   * all, preserving the old headerless look (confirmDialog, itemModal.ts's
   * own inline-editable title). */
  header?: HTMLElement;
  body: HTMLElement;
  /** Dedicated footer region -- `appendModalActions`/`appendModalCloseButton`
   * append into this, not `body`, so every modal gets exactly one visually
   * distinct footer instead of a button row flowing as the last item of an
   * undifferentiated body. */
  footer: HTMLElement;
  close: () => void;
}

/**
 * Creates a modal, appends it and returns a handle.
 *
 * Escape and backdrop clicks close it; an `onClose` hook lets callers release
 * resources (the crop modal destroys its Cropper instance there, which
 * otherwise leaks a canvas and its event listeners on every open).
 */
let modalIdSeq = 0;

export function openModal(options: {
  className?: string;
  maxWidth?: string;
  /** Builds a real `.modal-header` containing an `<h3>` with this text --
   * the Curodav-style header/body/footer structure (design-system
   * unification pass, 2026-09-19). Sets aria-labelledby directly instead of
   * relying on the fallback MutationObserver below. */
  title?: string;
  /** For a caller that needs a richer header than a single title string
   * (openDuplicatesModal's title + subtitle hint) -- builds an empty
   * `.modal-header` div on `modal.header` for the caller to fill in
   * itself. Ignored if `title` is also given (title's own header covers it). */
  customHeader?: boolean;
  onClose?: () => void;
}): ModalHandle {
  const backdrop = el("div", { class: "modal-backdrop active" });
  const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true" });
  if (options.maxWidth) modal.style.maxWidth = options.maxWidth;

  const closeBtn = el("button", { class: "close-btn", "aria-label": "Close" }, icon("close"));
  // On mobile the modal renders as a bottom sheet (see the `@media (max-width:
  // 640px)` rules in styles.css) — this handle is what makes that draggable.
  // It used to be a purely decorative `::before` pseudo-element, which looked
  // like a grab handle but couldn't actually receive touch events, so nothing
  // happened when someone tried to drag it closed. A real element, listened on
  // directly, is what makes the drag work; it's also scoped to just the handle
  // (not the whole sheet) so it doesn't fight scrolling or tapping things
  // inside the body.
  const sheetHandle = el("div", { class: "sheet-handle", "aria-hidden": "true" });
  // `content` is the actual flex-column child of `.modal` -- see ModalHandle's
  // own doc comment for why this indirection exists (keeps `.modal`'s base
  // row-flex, which itemModal.ts's img/info panes rely on, untouched).
  const content = el("div", { class: "modal-content" });
  const body = el("div", { class: options.className ?? "simple-modal-body" });
  const footer = el("div", { class: "modal-footer" });
  let header: HTMLElement | undefined;
  const titleId = `modal-title-${++modalIdSeq}`;
  if (options.title || options.customHeader) {
    header = el("div", { class: "modal-header" });
    if (options.title) {
      const h3 = el("h3");
      h3.textContent = options.title;
      h3.id = titleId;
      header.append(h3);
      modal.setAttribute("aria-labelledby", titleId);
    }
    content.append(header);
  }
  content.append(body, footer);
  modal.append(closeBtn, sheetHandle, content);
  backdrop.append(modal);
  document.body.append(backdrop);
  // Fallback for callers that didn't pass `title` (itemModal.ts's own
  // inline-editable heading, confirmDialog's headerless message) -- watches
  // for the first <h1>/<h2>/<h3> the caller appends into `body` itself and
  // wires aria-labelledby to it, the same way every modal worked before the
  // `title` option existed.
  const titleObserver = new MutationObserver(() => {
    const heading = body.querySelector("h1, h2, h3");
    if (heading) {
      heading.id = titleId;
      modal.setAttribute("aria-labelledby", titleId);
      titleObserver.disconnect();
    }
  });
  if (!header) titleObserver.observe(body, { childList: true });
  // Moves keyboard focus into the modal the instant it opens — otherwise
  // focus stays wherever it was on the page underneath, and Tab from there
  // ignores the modal entirely rather than starting inside it.
  closeBtn.focus();

  const previouslyFocused = document.activeElement as HTMLElement | null;

  const close = () => {
    document.removeEventListener("keydown", onKey);
    titleObserver.disconnect();
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

  // Drag-to-close for the mobile bottom sheet. Follows the finger 1:1 while
  // dragging (no CSS transition fighting the pointer), then on release either
  // completes the dismiss (dragged past a quarter of the sheet's own height)
  // or snaps back — the transition for that snap/dismiss animation is
  // `.modal`'s own `transition: transform`, scoped to the same mobile
  // breakpoint this only runs at, so desktop's centered dialogs are
  // unaffected either way.
  let dragPointerId: number | null = null;
  let dragStartY = 0;
  const isMobileSheet = () => window.matchMedia("(max-width: 640px)").matches;
  const resetDragState = () => {
    dragPointerId = null;
    modal.style.transition = "";
    modal.style.transform = "";
  };
  sheetHandle.addEventListener("pointerdown", (event) => {
    if (!isMobileSheet()) return;
    dragPointerId = event.pointerId;
    dragStartY = event.clientY;
    modal.style.transition = "none";
    sheetHandle.setPointerCapture(event.pointerId);
  });
  sheetHandle.addEventListener("pointermove", (event) => {
    if (dragPointerId !== event.pointerId) return;
    const delta = Math.max(0, event.clientY - dragStartY);
    modal.style.transform = `translateY(${delta}px)`;
  });
  const endDrag = (event: PointerEvent) => {
    if (dragPointerId !== event.pointerId) return;
    const delta = Math.max(0, event.clientY - dragStartY);
    const dismissThreshold = modal.getBoundingClientRect().height * 0.25;
    modal.style.transition = "";
    if (delta > dismissThreshold) {
      modal.style.transform = "translateY(100%)";
      setTimeout(close, 180);
    } else {
      modal.style.transform = "";
    }
    dragPointerId = null;
  };
  sheetHandle.addEventListener("pointerup", endDrag);
  sheetHandle.addEventListener("pointercancel", (event) => {
    if (dragPointerId !== event.pointerId) return;
    resetDragState();
  });

  return { backdrop, content, header, body, footer, close };
}

/**
 * Standard entity-form modal footer (design-system unification pass,
 * originally 2026-09-17, rebuilt 2026-09-19 to match Curodav's own footer
 * layout exactly rather than just structurally): Cancel on the left at its
 * natural width, a spacer, then the optional `secondary` action, then the
 * primary action on the right -- also at natural width, not stretched to
 * fill the row the way the previous equal-width pill pair did. `secondary`
 * (categoryModal/graphRuleModal/linkModal's "Delete X", only rendered when
 * editing an existing entity) is expected to already carry the `.delete-link`
 * class (a demoted text-link style, not a full button) rather than being a
 * peer-weight action next to Cancel/Save -- matches Curodav's own delete
 * link sitting between the spacer and the primary button.
 */
export function appendModalActions(
  modal: ModalHandle,
  primary: HTMLButtonElement,
  secondary?: HTMLElement,
): HTMLButtonElement {
  const cancel = el("button", { class: "btn btn-outlined", type: "button" }) as HTMLButtonElement;
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => modal.close());
  modal.footer.append(cancel, el("div", { class: "spacer" }));
  if (secondary) modal.footer.append(secondary);
  modal.footer.append(primary);
  return cancel;
}

/**
 * For a modal that applies each change immediately (no distinct "primary"
 * action separate from just closing) -- `pickBoard`/`openTagsEditorModal`/
 * `openTagToggleModal`, all footer-less before this pass. `appendModalActions`
 * doesn't fit these: it always requires a `primary` button and always
 * synthesizes its own Cancel, which would either force a meaningless fake
 * primary or produce two buttons where only one dismiss action is wanted.
 * Right-aligns a single button via the same spacer technique.
 */
export function appendModalCloseButton(modal: ModalHandle, label = "Close"): HTMLButtonElement {
  const button = el("button", { class: "btn btn-outlined", type: "button" }) as HTMLButtonElement;
  button.textContent = label;
  button.addEventListener("click", () => modal.close());
  modal.footer.append(el("div", { class: "spacer" }), button);
  return button;
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
    modal.body.append(text);
    const cancel = el("button", { class: "btn btn-outlined", type: "button" }) as HTMLButtonElement;
    cancel.textContent = "Cancel";
    const confirm = el("button", { class: "btn btn-error-tonal", type: "button" }) as HTMLButtonElement;
    confirm.textContent = confirmLabel;
    modal.footer.append(cancel, el("div", { class: "spacer" }), confirm);

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

/** sRGB (0-255) channel to linear light (0-1) — the de-gamma step WCAG's
 * relative luminance formula is defined over. */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Picks legible text colour — white or near-black — for text drawn directly
 * on top of an arbitrary background colour, e.g. a tag chip's label sitting
 * on that tag's own colour.
 *
 * This used to instead *darken the background* until white text held up
 * against it (`contrastSafeColor`, since removed) — which meant the colour
 * actually shown was never quite the one picked: a bright, light colour
 * chosen in the tag editor got quietly muted everywhere it was displayed, so
 * "the tag is blue" and "the swatch just picked" didn't always match. The
 * background should always be the exact colour someone chose; it's the
 * *text* that should adapt to it, not the other way around. WCAG relative
 * luminance (it weights green highest, blue lowest, matching perceived
 * brightness — plain HSL lightness does not, so a bright yellow and a bright
 * blue at the same lightness are not equally readable under white text) is
 * used to compute the actual contrast ratio for white vs. near-black text
 * against the given colour, and whichever wins is returned.
 */
export function readableTextColor(hex: string): string {
  let clean = hex.trim();
  if (!/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(clean)) return "#fff";
  if (!clean.startsWith("#")) clean = `#${clean}`;
  const [r, g, b] = hexToRgb(clean);

  const linR = srgbToLinear(r);
  const linG = srgbToLinear(g);
  const linB = srgbToLinear(b);
  const luminance = 0.2126 * linR + 0.7152 * linG + 0.0722 * linB;

  // WCAG contrast ratio: (lighter + 0.05) / (darker + 0.05). White is
  // luminance 1, black is luminance 0, so these simplify to the below.
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  return contrastWithWhite >= contrastWithBlack ? "#fff" : "#1a1a1a";
}

/**
 * A tag's displayed colour: its own colour if set, else its supercategory's
 * colour, else a deterministic per-id fallback. Returned exactly as stored —
 * whatever's shown (chip background, graph node, dot) is meant to be the
 * literal colour someone picked, not a muted approximation of it. Anywhere
 * text sits on top of this colour, pair it with `readableTextColor` for the
 * text itself rather than adjusting the colour here.
 *
 * The per-id fallback is keyed on the tag id so an uncategorized tag keeps the
 * same colour across reloads and across the grid, modal and graph — a random
 * colour per render would make the graph unreadable between visits. A
 * category's colour is checked before that fallback so recolouring a category
 * (or filing a tag under one) is what actually changes what the tag looks
 * like everywhere, rather than every tag needing its own colour picked by hand.
 */
export function tagColor(tag: { id: number; color: string | null; category?: { color: string } | null }): string {
  return tag.color || tag.category?.color || TAG_PALETTE[tag.id % TAG_PALETTE.length];
}

/**
 * A tag's icon: its own if it has one, else its category's — the same
 * "own value wins, category is the default" precedence `tagColor` uses.
 * Unlike colour there is no synthetic fallback; a tag with no icon of its
 * own and no categorized default simply has none. Returns a key into
 * `ICONS` (see icons.ts), not markup — callers render it with `icon()`.
 */
export function tagIconKey(
  tag: { icon?: string | null; category?: { icon?: string | null } | null } | null | undefined,
): string | null {
  return tag?.icon || tag?.category?.icon || null;
}

/**
 * Appends a tag's resolved icon (if any) followed by its name, as real DOM
 * nodes rather than an HTML string — a tag name can contain `<`/`&`
 * (anything a person can type), so it goes in as a text node; only the icon
 * key, which only ever comes from the fixed picker set, goes in as markup.
 */
export function appendTagLabel(
  container: HTMLElement,
  tag: { name: string; icon?: string | null; category?: { icon?: string | null } | null },
): void {
  const key = tagIconKey(tag);
  if (key) container.insertAdjacentHTML("beforeend", icon(key, true));
  container.append(document.createTextNode(tag.name));
}

