/**
 * A brief, one-time "Add to Home Screen" nudge (advance.md §14).
 *
 * The manifest (public/manifest.json) already makes the app installable —
 * the gap this closes is discoverability, not support: Chrome and Edge on
 * Android surface an automatic install prompt, but Firefox, Samsung Internet
 * and Opera require finding it in a menu, and iOS Safari has no automatic
 * prompt at all — install lives in the Share sheet there. Each of those is a
 * different "how", so the tip's wording is keyed off a coarse browser/OS
 * sniff rather than one generic "install this app" line that would be wrong
 * for most of the audience it reaches.
 *
 * Shown at most once per browser: dismissing it (or installing) sets a
 * localStorage flag that suppresses it for good on this device.
 */

import { el } from "../ui";

const DISMISSED_KEY = "artboard.installTipDismissed";

function alreadyHandled(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return true; // private mode: don't nag every load with no way to remember dismissal
  }
}

function markHandled(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    /* nothing to do — see alreadyHandled */
  }
}

/** Already running installed (standalone display mode), on any platform. */
function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's own (non-standard) flag for "launched from the home screen".
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function instructionsFor(ua: string): string | null {
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);
  if (isIOS) {
    return 'Install this app: tap the Share icon, then "Add to Home Screen".';
  }
  if (isAndroid) {
    if (/firefox/.test(ua)) return 'Install this app: open the browser menu (⋮) and choose "Install".';
    if (/samsungbrowser/.test(ua)) return 'Install this app: open the browser menu and choose "Add page to" → "Home screen".';
    if (/opr\//.test(ua)) return 'Install this app: open the browser menu and choose "Add to home screen".';
    // Chrome/Edge on Android normally surface their own automatic install
    // banner — this is a fallback in case that banner was previously
    // dismissed by the browser itself, not a duplicate of it.
    return 'Install this app for quicker access: open the browser menu (⋮) and choose "Install app" or "Add to Home screen".';
  }
  return null; // Desktop: browser install affordances (address bar icon, etc.) are discoverable enough on their own.
}

export function maybeShowInstallTip(): void {
  if (alreadyHandled() || isStandalone()) return;
  const message = instructionsFor(navigator.userAgent.toLowerCase());
  if (!message) return;

  const banner = el("div", { class: "install-tip-banner" });
  const text = el("span");
  text.textContent = message;
  const dismiss = el("button", {
    type: "button",
    class: "toast-action",
    style: "color:#fff; margin-left:16px;",
  });
  dismiss.textContent = "Got it";
  dismiss.addEventListener("click", () => {
    markHandled();
    banner.remove();
  });
  banner.append(text, dismiss);
  document.body.append(banner);
}
