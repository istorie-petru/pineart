/**
 * Headless smoke test for the production build.
 *
 * Loads dist/index.html in jsdom against a *running backend* and asserts that
 * the app boots and renders real data. This is not a substitute for looking at
 * the app in a browser — jsdom has no layout engine, so it cannot tell you the
 * masonry looks right — but it does catch the failure mode that a typecheck
 * cannot: a runtime error during boot, a wrong field name, or a view that
 * throws when it meets real API responses.
 *
 * Usage: node scripts/smoke.mjs [backendUrl] [distDir]
 *   ARTBOARD_DEMO_PASSWORD overrides the password (matches seed_demo.py).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { JSDOM, VirtualConsole } = await import("jsdom");

const backend = process.argv[2] ?? "http://127.0.0.1:8000";
const distDir = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

const assets = readdirSync(join(distDir, "assets"));
const bundle = readFileSync(join(distDir, "assets", assets.find((f) => f.endsWith(".js"))), "utf8");
const html = readFileSync(join(distDir, "index.html"), "utf8");

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(error.message));
virtualConsole.on("error", (...args) => errors.push(args.join(" ")));

const dom = new JSDOM(html, {
  url: "http://localhost/#/boards/organized",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;

// jsdom implements neither of these; the app uses ResizeObserver for masonry
// re-layout and matchMedia for the system theme.
window.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};

// jsdom has no IntersectionObserver. The stub records instances so the infinite
// scroll sentinel can be triggered on demand, which is the only way to test
// auto-loading without a layout engine.
const observers = [];
window.IntersectionObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.targets = [];
    observers.push(this);
  }
  observe(target) {
    this.targets.push(target);
  }
  disconnect() {
    this.targets = [];
    const index = observers.indexOf(this);
    if (index >= 0) observers.splice(index, 1);
  }
  trigger() {
    this.callback(this.targets.map((target) => ({ isIntersecting: true, target })));
  }
};

// jsdom's cookie jar is not wired to node's fetch, so the session cookie is
// carried manually here. The app itself is unchanged — it still relies on the
// browser sending the cookie, which is what a real browser does.
let sessionCookie = "";
const password = process.env.ARTBOARD_DEMO_PASSWORD ?? "demo-password-123";
const loginResponse = await fetch(`${backend}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
if (!loginResponse.ok) {
  console.error(`Login failed (${loginResponse.status}). Seed the backend first: python scripts/seed_demo.py`);
  process.exit(1);
}
sessionCookie = (loginResponse.headers.getSetCookie?.() ?? [])[0]?.split(";")[0] ?? "";

window.fetch = (input, init = {}) =>
  fetch(new URL(String(input), backend), {
    ...init,
    headers: { ...(init.headers ?? {}), ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
  }).then(
    (response) =>
      new window.Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
      }),
  );
window.Response = Response;
window.Headers = Headers;
window.Request = Request;
window.FormData = FormData;
// jsdom has no object URLs; the upload dialog uses them for its previews.
window.URL.createObjectURL = () => "blob:stub";
window.URL.revokeObjectURL = () => {};

// Records which file picker the app tried to open, so the upload menu can be
// tested without a real browser dialog.
let pickerOpened = null;
window.HTMLInputElement.prototype.click = function () {
  if (this.type === "file") pickerOpened = this.hasAttribute("webkitdirectory") ? "folder" : "files";
};

window.eval(bundle);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(1500);

const document = window.document;
const checks = [];
const check = (name, condition, detail = "") => checks.push({ name, ok: Boolean(condition), detail });

// Auth gate: the app must have got past login and shown its chrome.
check("logged in past the auth gate", document.querySelector("#app .profile-header") !== null);
check("nav chrome visible once authenticated", document.getElementById("topNav")?.hidden === false);

// Boards view
check("profile name rendered", document.querySelector(".profile-name")?.textContent?.trim().length > 0,
  document.querySelector(".profile-name")?.textContent ?? "");
check("link pills rendered", document.querySelectorAll(".link-pill").length >= 3,
  `${document.querySelectorAll(".link-pill").length} pills`);
check("board cards rendered", document.querySelectorAll(".board-card").length >= 2,
  `${document.querySelectorAll(".board-card").length} boards`);
check("dynamic board badged", [...document.querySelectorAll(".badge")].some((b) => b.textContent === "dynamic"));

// Unorganized grid
window.location.hash = "#/boards/unorganized";
await wait(1200);
const cards = document.querySelectorAll("#app .masonry .card");
check("item cards rendered", cards.length > 0, `${cards.length} cards`);
check("thumbnails point at the derivative endpoint",
  cards[0]?.querySelector("img")?.getAttribute("src")?.includes("/file/thumb"),
  cards[0]?.querySelector("img")?.getAttribute("src") ?? "");
check("dominant colour placeholder set", Boolean(cards[0]?.querySelector("img")?.style?.background));
check("hover overlay carries an action", cards[0]?.querySelector(".overlay .save-btn") !== null);
check("kebab menu offers the crop destinations",
  cards[0]?.querySelectorAll(".kebab-menu button").length === 2);
check("Load more and Surprise me share one row",
  [...document.querySelectorAll("#app button")].some((b) => b.textContent.includes("Surprise me")) &&
    document.querySelectorAll("#app .masonry ~ div button").length >= 1);

// Board detail
const boardHash = "#/board/1";
window.location.hash = boardHash;
await wait(1200);
check("board detail title rendered", document.querySelector(".view-title")?.textContent?.length > 0,
  document.querySelector(".view-title")?.textContent ?? "");
check("board detail grid populated", document.querySelectorAll("#app .masonry .card").length > 0);

// Settings, including the graph tab
window.location.hash = "#/settings/tags";
await wait(1500);
check("settings tabs rendered", document.querySelectorAll(".settings-nav-item").length === 8);
check("tag graph drew nodes", document.querySelectorAll("#tagGraph .graph-node").length > 0,
  `${document.querySelectorAll("#tagGraph .graph-node").length} nodes`);
check("tag graph drew edges", document.querySelectorAll("#tagGraph line").length > 0,
  `${document.querySelectorAll("#tagGraph line").length} edges`);

window.location.hash = "#/settings/trash";
await wait(1000);
check("trash panel built", document.querySelector(".settings-panel.active") !== null);

window.location.hash = "#/settings/discovery";
await wait(1000);
{
  const rows = document.querySelectorAll(".template-row");
  check("discovery lists recommended search templates", rows.length >= 6, `${rows.length} rows`);
  check("templates are shown as copyable text",
    [...rows].some((row) => row.querySelector("code")?.textContent?.includes("{query}")));
  check("a template can be applied or saved",
    [...rows[0].querySelectorAll("button")].map((b) => b.textContent).join(",") === "Use,Save");
}

// Infinite scroll and selection mode, both on the unorganized grid.
{
  // Force a small page size first, otherwise the seeded collection fits on page
  // one and "auto-loading works" would pass without ever loading anything.
  await fetch(`${backend}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    body: JSON.stringify({ values: { "collection.page_size": 4 } }),
  });

  window.location.hash = "#/boards/organized";
  await wait(200);
  window.location.hash = "#/boards/unorganized";
  await wait(1200);

  const grid = document.querySelector("#app .masonry");
  const idsOf = () => [...grid.querySelectorAll(".card")].map((c) => c.dataset.itemId);

  const before = idsOf();
  check("first page respects the page size", before.length === 4, `${before.length} cards`);

  const sentinel = () => observers[observers.length - 1];
  // Fired twice in a row on purpose: the second must be ignored while the first
  // request is still out, or the same page lands twice.
  sentinel()?.trigger();
  sentinel()?.trigger();
  await wait(700);
  const afterOne = idsOf();
  check("infinite scroll loaded the next page", afterOne.length > before.length,
    `${before.length} -> ${afterOne.length}`);
  check("a double trigger did not double-load", afterOne.length === 8,
    `expected 8, got ${afterOne.length}`);

  // Expected count comes from the API rather than a literal: profile crops and
  // versions are deliberately not cards, so hardcoding a number here would break
  // every time that boundary moves.
  const expected = (await (await fetch(`${backend}/api/items?limit=1`, {
    headers: { Cookie: sessionCookie },
  })).json()).total;

  for (let i = 0; i < 8; i += 1) {
    sentinel()?.trigger();
    await wait(300);
    if (idsOf().length >= expected) break;
  }
  const after = idsOf();
  check("scrolling to the end loads every item", after.length === expected,
    `${after.length} of ${expected}`);
  check("no duplicate cards after auto-loading", new Set(after).size === after.length,
    `${after.length} cards, ${new Set(after).size} unique`);

  await fetch(`${backend}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    body: JSON.stringify({ values: { "collection.page_size": 40 } }),
  });

  // Selection mode: the first checkbox click arms it, after which a click
  // anywhere on another card selects rather than opens.
  const cards = [...grid.querySelectorAll(".card")];
  cards[0].querySelector(".select-box").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(60);
  check("first checkbox click selects", cards[0].classList.contains("selected"));
  check("grid enters selection mode", grid.classList.contains("selecting"));

  cards[1].querySelector("img").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(60);
  check("clicking a card body selects it while in selection mode", cards[1].classList.contains("selected"));
  check("no modal opened during selection", document.querySelector(".modal-backdrop") === null);

  cards[1].querySelector("img").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  cards[0].querySelector("img").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(60);
  check("deselecting everything leaves selection mode", !grid.classList.contains("selecting"));

  cards[0].querySelector("img").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(200);
  check("a normal click opens the item once selection mode is off",
    document.querySelector(".modal-backdrop") !== null);
  document.querySelector(".modal-backdrop .close-btn")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(60);
}

// Drag and drop upload.
{
  const makeDragEvent = (type, files) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    event.dataTransfer = { types: ["Files"], files, dropEffect: "" };
    return event;
  };

  window.dispatchEvent(makeDragEvent("dragenter", []));
  await wait(60);
  check("dragging files over the window shows the drop overlay",
    document.querySelector(".drop-overlay") !== null);

  const dragover = makeDragEvent("dragover", []);
  window.dispatchEvent(dragover);
  check("dragover is cancelled so the drop can fire", dragover.defaultPrevented);

  window.dispatchEvent(makeDragEvent("dragleave", []));
  await wait(60);
  check("leaving hides the overlay", document.querySelector(".drop-overlay") === null);

  // A drop of a non-image must not navigate away, which is the browser default.
  window.dispatchEvent(makeDragEvent("dragenter", []));
  const drop = makeDragEvent("drop", [new window.File(["x"], "notes.txt", { type: "text/plain" })]);
  window.dispatchEvent(drop);
  await wait(100);
  check("drop is cancelled so the browser does not open the file", drop.defaultPrevented);
  check("overlay is dismissed after a drop", document.querySelector(".drop-overlay") === null);

  // Any modal left open by an earlier block would be picked up instead of the
  // one under test.
  document.querySelectorAll(".modal-backdrop").forEach((node) => node.remove());

  // Dropping actual images opens the confirm dialog rather than uploading blind.
  window.dispatchEvent(makeDragEvent("dragenter", []));
  const image = new window.File(["fake-png-bytes"], "art.png", { type: "image/png" });
  window.dispatchEvent(makeDragEvent("drop", [image, image]));
  await wait(500);

  const dialog = document.querySelector(".modal-backdrop");
  check("dropping images opens the upload dialog", dialog !== null);
  check("the dialog says how many images", dialog?.querySelector("h3")?.textContent === "Add 2 images",
    dialog?.querySelector("h3")?.textContent ?? "");
  check("the dialog offers a tag field", dialog?.querySelector(".tag-input") !== null);
  check("the dialog offers a board selector", dialog?.querySelector("select") !== null);

  // Suggestions: typing a half-remembered fragment must offer the real tag.
  const tagField = dialog?.querySelector(".tag-input input");
  if (tagField) {
    tagField.value = "landscap";
    tagField.dispatchEvent(new window.Event("input", { bubbles: true }));
    await wait(700);
    const menu = dialog.querySelector(".tag-suggestions");
    const offered = [...(menu?.querySelectorAll(".tag-suggestion-name") ?? [])].map((n) => n.textContent);
    check("tag suggestions appear while typing", menu?.classList.contains("open"), offered.join(", "));
    check("a typo still offers the intended tag", offered.includes("landscape"), offered.join(", "));
  } else {
    check("tag suggestions appear while typing", false, "no tag field found");
    check("a typo still offers the intended tag", false, "no tag field found");
  }

  // Cancel: merely opening the dialog must not have uploaded anything.
  [...(dialog?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Cancel")?.click();
  await wait(150);
  check("cancelling the upload dialog closes it", document.querySelector(".modal-backdrop") === null);
}

// Item modal: paste trimming, versions, and shortcuts staying out of the way
// while typing.
{
  window.location.hash = "#/boards/unorganized";
  await wait(1000);
  document.querySelectorAll(".modal-backdrop").forEach((node) => node.remove());

  const firstCard = document.querySelector("#app .masonry .card");
  firstCard.querySelector("img").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(900);

  const modal = document.querySelector(".modal-backdrop");
  check("item modal opened", modal !== null);

  // Versions strip is rendered for every artwork, even single-file ones.
  check("versions section present", modal?.querySelector(".version-block") !== null);
  check("single-file artwork explains itself rather than showing an empty strip",
    modal?.querySelector(".version-strip")?.textContent?.includes("One file"));

  // Arrow keys must not navigate while a text field has focus.
  const heading = modal.querySelector("h3.editable");
  heading?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await wait(80);
  const titleField = modal.querySelector("input[type=text], textarea");
  check("clicking the title opens an editor", titleField !== null);

  if (titleField) {
    const before = modal.querySelector(".img-pane img")?.getAttribute("src");
    titleField.focus();
    // Dispatched from the field, as a browser would, and also from the document
    // to cover the case where the shortcut listener sees a non-field target
    // while focus is nonetheless in the text box.
    titleField.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    await wait(200);
    const after = modal.querySelector(".img-pane img")?.getAttribute("src");
    check("arrow keys do not change image while typing", before === after, `${before} -> ${after}`);

    // Pasting trims surrounding whitespace.
    let inserted = null;
    window.document.execCommand = (command, _ui, value) => {
      if (command === "insertText") {
        inserted = value;
        return true;
      }
      return false;
    };
    const paste = new window.Event("paste", { bubbles: true, cancelable: true });
    paste.clipboardData = { getData: () => "  Rooftops at dusk \n" };
    titleField.dispatchEvent(paste);
    await wait(60);
    check("pasted text is trimmed", inserted === "Rooftops at dusk", JSON.stringify(inserted));
    check("the paste was intercepted", paste.defaultPrevented);
  }

  document.querySelectorAll(".modal-backdrop").forEach((node) => node.remove());
}

// Upload menu. This regressed once in a way a typecheck cannot catch: the menu
// reused the card kebab's CSS class, so the global "close all menus" handler
// hid it during the very click that opened it and the button looked dead.
{
  const click = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const uploadBtn = document.getElementById("uploadBtn");

  click(uploadBtn);
  await wait(50);
  let menu = document.querySelector(".menu-popover");
  check("upload menu survives the click that opened it", menu !== null);
  check("upload menu is actually visible", menu !== null && window.getComputedStyle(menu).display !== "none");
  check("upload menu offers files and folder", menu?.querySelectorAll("button").length === 2);

  click(uploadBtn);
  await wait(50);
  check("upload menu toggles shut", document.querySelector(".menu-popover") === null);

  click(uploadBtn);
  await wait(50);
  click(document.querySelector(".menu-popover").querySelectorAll("button")[0]);
  await wait(50);
  check("'Choose files' opens the file picker", pickerOpened === "files", `opened=${pickerOpened}`);

  pickerOpened = null;
  click(uploadBtn);
  await wait(50);
  click(document.querySelector(".menu-popover").querySelectorAll("button")[1]);
  await wait(50);
  check("'Import a whole folder' opens the directory picker", pickerOpened === "folder", `opened=${pickerOpened}`);

  click(uploadBtn);
  await wait(50);
  click(document.body);
  await wait(50);
  check("clicking outside closes the upload menu", document.querySelector(".menu-popover") === null);
}

check("no runtime errors", errors.length === 0, errors.slice(0, 3).join(" | "));

// Second pass with no session: the app must show the login screen and keep its
// chrome hidden, rather than rendering an empty collection.
{
  const anonDom = new JSDOM(html, {
    url: "http://localhost/#/boards/organized",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const anon = anonDom.window;
  anon.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  anon.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  anon.scrollTo = () => {};
  anon.fetch = (input, init) =>
    fetch(new URL(String(input), backend), init).then(
      (response) =>
        new anon.Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers),
        }),
    );
  anon.Response = Response;
  anon.Headers = Headers;
  anon.Request = Request;
  anon.FormData = FormData;
  anon.eval(bundle);
  await wait(1200);

  const anonDoc = anon.document;
  check("logged-out visitor gets the login form", anonDoc.querySelector('input[type="password"]') !== null);
  check("logged-out visitor sees no collection", anonDoc.querySelector("#app .card") === null);
  check("nav chrome hidden when logged out", anonDoc.getElementById("topNav")?.hidden === true);
}

let failed = 0;
for (const result of checks) {
  if (!result.ok) failed += 1;
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `  (${result.detail})` : ""}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
