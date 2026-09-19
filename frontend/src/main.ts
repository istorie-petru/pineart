/** Application entry point: nav, routing, uploads. */

import "./styles.css";
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";

import { api, setConnectivityHandler, setUnauthorizedHandler } from "./api";
import { initAddImages, toggleAddImagesMenu } from "./components/addImagesMenu";
import { maybeShowInstallTip } from "./components/installTip";
import { openUploadDialog, reportUpload } from "./components/uploadDialog";
import { icon } from "./icons";
import * as router from "./router";
import { store } from "./store";
import { el, installPasteTrimming, qs, renderErrorView, setConnectivityBannerVisible, toast } from "./ui";
import { renderBoardDetail } from "./views/boardDetail";
import { renderBoardsView, type BoardsViewHandle } from "./views/boards";
import { renderFeed } from "./views/feed";
import { renderLogin } from "./views/login";
import { renderSettings, type SettingsViewHandle } from "./views/settings";

const app = qs("#app");
const topNav = qs("#topNav");
const bottomTabbar = qs("#bottomTabbar");

let teardown: (() => void) | null = null;
// Tracked separately from `teardown` so a sub-tab switch within an already-
// mounted boards/settings view can be detected and handled without tearing
// it down (a settings sidebar click would otherwise destroy and re-fetch the
// tag graph and trash grid on every single click).
let boardsHandle: BoardsViewHandle | null = null;
let settingsHandle: SettingsViewHandle | null = null;
let authenticated = false;

function showLogin(setupRequired: boolean): void {
  teardown?.();
  teardown = null;
  // Neither handle is valid once the DOM they pointed at is torn down and
  // replaced with the login screen — left stale, a log-out-then-back-in
  // while sitting on Boards or Settings would hit the fast-path branch below
  // against elements that no longer exist.
  boardsHandle = null;
  settingsHandle = null;
  authenticated = false;
  setChromeVisible(false);
  renderLogin(app, setupRequired, () => {
    void boot();
  });
}

/** The nav and settings controls are meaningless before login, so they are hidden. */
function setChromeVisible(visible: boolean): void {
  topNav.hidden = !visible;
  qs("#settingsBtn").hidden = !visible;
  bottomTabbar.style.display = visible ? "" : "none";
}

function render(route: router.Route): void {
  if (!authenticated) return;

  if (route.view === "boards" && boardsHandle) {
    // Unorganized <-> Organized is a tab switch within one already-mounted
    // view, not a navigation to a different one — tearing the whole thing
    // down and rebuilding it re-fetched links, the on-this-day banner, the
    // item grid and the boards list every single time, which is where the
    // ~1s stall switching tabs used to come from. None of that data goes
    // stale from a tab switch itself: every mutation (a new board, a deleted
    // item, a renamed tag) already refreshes its own grid directly rather
    // than counting on the next tab switch to notice.
    window.scrollTo(0, 0);
    boardsHandle.setSub(route.sub);
    syncNav(route);
    return;
  }

  if (route.view === "settings" && settingsHandle) {
    window.scrollTo(0, 0);
    settingsHandle.setTab(route.tab);
    syncNav(route);
    return;
  }

  teardown?.();
  teardown = null;
  boardsHandle = null;
  settingsHandle = null;
  window.scrollTo(0, 0);

  switch (route.view) {
    case "boards":
      boardsHandle = renderBoardsView(app, route.sub);
      teardown = boardsHandle.destroy;
      break;
    case "board":
      teardown = renderBoardDetail(app, route.id);
      break;
    case "settings":
      settingsHandle = renderSettings(app, route.tab);
      teardown = settingsHandle.destroy;
      break;
    case "feed":
      teardown = renderFeed(app);
      break;
  }
  syncNav(route);
}

function syncNav(route: router.Route): void {
  const activeView = route.view === "board" ? "boards" : route.view;
  // A board's own detail page has no sub-tab of its own — it's reached from
  // Organized, so that's the tab that stays highlighted while viewing it.
  const activeSub = route.view === "boards" ? route.sub : route.view === "board" ? "organized" : undefined;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    const matchesView = button.dataset.view === activeView;
    const matchesSub = !button.dataset.sub || button.dataset.sub === activeSub;
    button.classList.toggle("active", matchesView && matchesSub);
  }
  updateFeedVisibility();
}

/**
 * The Feed nav item exists only once Discovery is configured (architecture §6).
 * If discovery is switched off while Feed is the active view, the app falls back
 * to Boards rather than leaving a dead destination selected.
 */
function updateFeedVisibility(): void {
  const enabled = store.discoveryEnabled;
  document.querySelectorAll<HTMLElement>('[data-view="feed"]').forEach((button) => {
    button.hidden = !enabled;
  });
  if (!enabled && router.current().view === "feed") {
    router.navigate({ view: "boards", sub: "organized" });
  }
}

function buildNav(): void {
  qs("#settingsBtn").innerHTML = icon("settings", true);

  const addImagesBtn = qs("#addImagesBtn");
  addImagesBtn.innerHTML = `${icon("upload", true)} Add images`;
  addImagesBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAddImagesMenu(addImagesBtn);
  });

  for (const [view, label, iconName, sub] of [
    ["feed", "Discover", "search", undefined],
    ["boards", "Feed", "image", "unorganized"],
    ["boards", "Boards", "boards", "organized"],
    ["settings", "Settings", "settings", undefined],
  ] as [string, string, string, string | undefined][]) {
    const button = el("button", sub ? { "data-view": view, "data-sub": sub } : { "data-view": view });
    button.innerHTML = `${icon(iconName)}<span>${label}</span>`;
    if (view === "feed") button.hidden = true;
    bottomTabbar.append(button);
  }

  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.dataset.view;
      if (view === "feed") router.navigate({ view: "feed" });
      else if (view === "settings") router.navigate({ view: "settings", tab: "profile" });
      else router.navigate({ view: "boards", sub: (button.dataset.sub as "unorganized" | "organized") ?? "organized" });
    });
  });
}

/** Wires the shared file inputs and drag-and-drop behind the topbar's own
 * "Add images" button (desktop only — the topbar itself is hidden below
 * 640px, per `header.topnav`'s media query in styles.css). */
function setupUploads(): void {
  // Both entry points (picker and drop) go through the same dialog, so tagging
  // and filing behave identically however the images arrived.
  const handleFiles = (files: File[]) => {
    if (!files.length) return;
    openUploadDialog(files, (outcome) => {
      reportUpload(outcome);
      void store.loadTags();
      router.navigate(router.current());
    });
  };

  initAddImages(handleFiles);
  setupDropTarget(handleFiles);
}

let chromeBuilt = false;

/**
 * Drop images anywhere on the window to upload them.
 *
 * Two things make this fiddlier than it looks. First, the browser's default
 * action for a dropped image is to *navigate to it*, discarding the app — so
 * both dragover and drop must preventDefault, on the window rather than on one
 * element. Second, dragenter/dragleave fire for every child element the pointer
 * crosses, so a naive "hide on dragleave" flickers constantly; a depth counter
 * tracks whether the pointer has genuinely left the window.
 */
function setupDropTarget(onFiles: (files: File[]) => void): void {
  let depth = 0;
  const overlay = el("div", { class: "drop-overlay" });
  overlay.innerHTML = `${icon("upload")}<span>Drop images to add them to your collection</span>`;

  const show = () => {
    if (!overlay.isConnected && authenticated) document.body.append(overlay);
  };
  const hide = () => {
    depth = 0;
    overlay.remove();
  };

  const carriesFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  window.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth += 1;
    show();
  });
  window.addEventListener("dragover", (event) => {
    if (!carriesFiles(event)) return;
    // Required every time, not just once: without preventDefault on dragover the
    // drop event never fires at all.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (event) => {
    if (!carriesFiles(event)) return;
    depth -= 1;
    if (depth <= 0) hide();
  });
  window.addEventListener("drop", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    hide();
    if (!authenticated) return;

    const dropped = Array.from(event.dataTransfer?.files ?? []);
    const images = dropped.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      // A dropped folder arrives as an entry with no type and no size; saying so
      // is better than silently doing nothing.
      const looksLikeFolder = dropped.some((file) => !file.type && !file.size);
      toast(
        looksLikeFolder
          ? "Dropping a folder is not supported — use Add images → Import a whole folder."
          : "Those files are not images.",
        "error",
      );
      return;
    }
    if (images.length < dropped.length) {
      toast(`Ignoring ${dropped.length - images.length} non-image file(s)`);
    }
    onFiles(images);
  });
}

/**
 * While the backend is unreachable, poll `/api/health` every few seconds so
 * the banner clears itself the moment the server comes back — the person
 * using a self-hosted app has no support team to tell them it's back, so the
 * app has to notice for them.
 */
let reconnectTimer: ReturnType<typeof setInterval> | null = null;
function watchForReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = setInterval(() => {
    void api
      .health()
      .then(() => {
        if (reconnectTimer !== null) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }
        setConnectivityBannerVisible(false);
        toast("Connection restored");
      })
      .catch(() => undefined);
  }, 4000);
}

async function boot(): Promise<void> {
  if (!chromeBuilt) {
    chromeBuilt = true;
    installPasteTrimming();
    buildNav();
    setupUploads();
    router.onChange(render);
    setUnauthorizedHandler(showLogin);
    setConnectivityHandler((online) => {
      setConnectivityBannerVisible(!online);
      if (!online) watchForReconnect();
    });
  }

  let status: { authenticated: boolean; setup_required: boolean };
  try {
    status = await api.authStatus();
  } catch {
    setChromeVisible(false);
    renderErrorView(app, {
      title: "Can't reach the server",
      message: "The backend didn't respond. Check that it's running (default: port 8000), then try again.",
      action: { label: "Retry", onClick: () => void boot() },
    });
    return;
  }

  if (!status.authenticated) {
    showLogin(status.setup_required);
    return;
  }

  authenticated = true;
  setChromeVisible(true);
  // Graph rules/edges aren't load-bearing for first paint (they only refine
  // the search filter dropdown once it's opened) — loaded alongside the rest
  // rather than blocking on them specifically, but still awaited here so
  // they're in hand before anyone can focus a search bar.
  await Promise.all([store.loadSettings(), store.loadTags(), store.loadGraph().catch(() => undefined)]);
  render(router.current());
  maybeShowInstallTip();
}

// Last-resort safety net: an uncaught exception anywhere else in the app
// currently means a blank white screen with no explanation, which is exactly
// the "clearly a dev tool" failure mode a styled error page exists to avoid.
// This only fires for genuinely uncaught errors — every request already goes
// through `guard()`, so this is the rare bug that slips past that.
window.addEventListener("error", (event) => {
  if (!app.children.length) {
    renderErrorView(app, {
      title: "Something went wrong",
      message: "The app hit an unexpected error. Reloading usually fixes this.",
      action: { label: "Reload", onClick: () => window.location.reload() },
    });
  }
  console.error(event.error ?? event.message);
});

void boot();
