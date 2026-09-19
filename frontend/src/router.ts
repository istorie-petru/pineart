/**
 * Hash routing.
 *
 * Hash rather than the History API because the app is served as static files by
 * a reverse proxy: with real paths, a refresh on /board/3 is a 404 unless the
 * proxy is configured to rewrite every unknown path to index.html. The hash
 * keeps deployment to "serve this directory" with no rewrite rule to forget.
 */

export type Route =
  | { view: "boards"; sub: "unorganized" | "organized" }
  | { view: "board"; id: number }
  | { view: "settings"; tab: string }
  | { view: "feed" };

export const SETTINGS_TABS = [
  "profile",
  "security",
  "appearance",
  "collection",
  "discovery",
  "tags",
  "trash",
  "data",
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function parse(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (path[0] === "feed") return { view: "feed" };
  if (path[0] === "board" && path[1]) return { view: "board", id: Number(path[1]) };
  if (path[0] === "settings") {
    const tab = path[1] && (SETTINGS_TABS as readonly string[]).includes(path[1]) ? path[1] : "profile";
    return { view: "settings", tab };
  }
  const sub = path[1] === "unorganized" ? "unorganized" : "organized";
  return { view: "boards", sub };
}

export function href(route: Route): string {
  switch (route.view) {
    case "feed":
      return "#/feed";
    case "board":
      return `#/board/${route.id}`;
    case "settings":
      return `#/settings/${route.tab}`;
    case "boards":
      return `#/boards/${route.sub}`;
  }
}

export function navigate(route: Route): void {
  const target = href(route);
  if (window.location.hash === target) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else window.location.hash = target;
}

export function onChange(handler: (route: Route) => void): void {
  window.addEventListener("hashchange", () => handler(parse(window.location.hash)));
}

export function current(): Route {
  return parse(window.location.hash);
}
