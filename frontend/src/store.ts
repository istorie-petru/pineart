/**
 * Shared application state: settings, tags, and theme application.
 *
 * Small on purpose — this is a data cache with change notification, not a
 * framework. Views read from it and subscribe; nothing here re-renders anything
 * by itself.
 */

import { api } from "./api";
import type { Settings, Tag, TagGraphRule } from "./types";

type Listener = () => void;

class Store {
  settings: Settings | null = null;
  tags: Tag[] = [];
  graphRules: TagGraphRule[] = [];
  /** Co-occurrence pairs from `/api/tags/graph`, as `"a-b"` keys in both
   * directions for O(1) "have these two tags ever appeared together?"
   * lookups — that's what search-filter gating (see `isConnected`) needs. */
  private graphEdges = new Set<string>();
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  async loadSettings(): Promise<Settings> {
    this.settings = await api.getSettings();
    this.applyTheme();
    this.emit();
    return this.settings;
  }

  async saveSettings(values: Partial<Record<keyof Settings, unknown>>): Promise<Settings> {
    this.settings = await api.putSettings(values);
    this.applyTheme();
    this.emit();
    return this.settings;
  }

  async loadTags(): Promise<Tag[]> {
    this.tags = await api.listTags();
    this.emit();
    return this.tags;
  }

  /**
   * Graph rules and their underlying co-occurrence edges, used to gate one
   * tag category behind another in the search filter dropdown — e.g. don't
   * offer every Character tag in the collection, only the ones connected to
   * whatever Show is already in the query (architecture: same rule the tag
   * graph visualization uses to suppress redundant edges, applied here to
   * suppress premature suggestions instead).
   */
  async loadGraph(): Promise<void> {
    const [rules, graph] = await Promise.all([api.listGraphRules(), api.tagGraph()]);
    this.graphRules = rules;
    const edges = new Set<string>();
    for (const edge of graph.edges) {
      edges.add(`${edge.source}-${edge.target}`);
      edges.add(`${edge.target}-${edge.source}`);
    }
    this.graphEdges = edges;
    this.emit();
  }

  isConnected(tagIdA: number, tagIdB: number): boolean {
    return this.graphEdges.has(`${tagIdA}-${tagIdB}`);
  }

  /**
   * Applies theme and accent to the document, and mirrors both into
   * localStorage so the inline script in index.html can set them before first
   * paint on the next load. Without that mirror every reload flashes the light
   * theme before settings arrive.
   */
  applyTheme(): void {
    const theme = this.settings?.["appearance.theme"] ?? "system";
    const accent = this.settings?.["appearance.accent_color"] ?? "#e63946";
    const dark =
      theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.setProperty("--color-accent", accent);
    try {
      localStorage.setItem("artboard.theme", theme);
      localStorage.setItem("artboard.accent", accent);
    } catch {
      /* private mode: the flash-prevention cache is a nicety, not a requirement */
    }
  }

  /** Discovery has no on/off switch — it's available as soon as a SearXNG
   * URL is configured. */
  get discoveryEnabled(): boolean {
    return Boolean(this.settings?.["discovery.searxng_url"]);
  }

  // ---------------------------------------------------------------------
  // "Remember last-used context" (advance.md §13) — small persisted bits of
  // state that make repeat visits less repetitive: the last board picked in
  // "add to board", the last sort/filter combination in Unorganized, the
  // last crop aspect ratio used. None of this is server state (it's specific
  // to this browser, not this collection), so plain localStorage rather than
  // a settings round-trip is the right layer for it.
  // ---------------------------------------------------------------------

  private readLocal(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private writeLocal(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: losing this preference across reloads is a nicety, not a bug */
    }
  }

  get lastBoardId(): number | null {
    const raw = this.readLocal("artboard.lastBoardId");
    return raw ? Number(raw) : null;
  }

  set lastBoardId(id: number) {
    this.writeLocal("artboard.lastBoardId", String(id));
  }

  /** Last sort/filter query string used in Unorganized — distinct from the
   * `sessionStorage` "pendingQuery" used for a one-off jump from elsewhere
   * (e.g. clicking a tag in the graph); this is the everyday "same as last
   * time" default for opening the tab with nothing else asking for a
   * specific query. */
  get lastUnorganizedQuery(): string {
    return this.readLocal("artboard.lastUnorganizedQuery") ?? "";
  }

  set lastUnorganizedQuery(query: string) {
    this.writeLocal("artboard.lastUnorganizedQuery", query);
  }

  get lastCropAspect(): string | null {
    return this.readLocal("artboard.lastCropAspect");
  }

  set lastCropAspect(aspect: string) {
    this.writeLocal("artboard.lastCropAspect", aspect);
  }
}

export const store = new Store();

// `system` theme has to track the OS setting live, not only at load.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (store.settings?.["appearance.theme"] === "system") store.applyTheme();
});
