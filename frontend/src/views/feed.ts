/**
 * Discover — SearXNG-backed discovery (architecture §6.1).
 *
 * Hidden from the nav until Discovery is configured, so a fresh install never
 * presents a search box that cannot return anything. Results come from the
 * backend proxy, never from the browser talking to SearXNG directly — that is
 * what keeps SearXNG bound to loopback.
 *
 * A session-only cache remembers the last 8 searches (8 photos each, 64
 * total) in sessionStorage, so landing back on this page shows what you were
 * just looking at instead of a blank box. It is deliberately not a hard
 * cache: sessionStorage clears itself when the tab closes, the oldest search
 * is dropped the moment a 9th one happens, and any single photo can be
 * removed from it by hand.
 */

import { api } from "../api";
import { TagInput } from "../components/tagInput";
import { icon } from "../icons";
import { layout, observe, type MasonryEntry } from "../masonry";
import * as router from "../router";
import { store } from "../store";
import type { DiscoverResult, Item } from "../types";
import { el, guard, openModal, toast } from "../ui";

const CACHE_KEY = "pineart.discoverCache";
const MAX_CACHED_SEARCHES = 8;
const MAX_PHOTOS_PER_SEARCH = 8;

interface CachedSearch {
  query: string;
  results: DiscoverResult[];
}

function loadCache(): CachedSearch[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCache(batches: CachedSearch[]): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(batches));
  } catch {
    /* Storage full or unavailable — the cache is a convenience, not load-bearing. */
  }
}

export function renderFeed(root: HTMLElement): () => void {
  if (!store.discoveryEnabled) {
    // Defensive: the nav item is hidden, but a bookmarked #/feed must not land
    // on a dead page.
    router.navigate({ view: "boards", sub: "organized" });
    return () => undefined;
  }

  const section = el("section", { class: "view active" });
  const heading = el("h2", { class: "view-title" });
  heading.textContent = "Discover";
  const description = el("p", { class: "view-desc" });
  description.textContent =
    "Search-driven browsing across external sources, proxied server-side through SearXNG. " +
    "“Add” downloads the image into your collection with no questions asked; “Add with details” " +
    "lets you set its title, tags and board first.";

  const row = el("div", { class: "search-row", style: "margin-bottom:16px;" });
  const inputWrap = el("div", { class: "search-input-wrap" }, icon("search", true));
  const input = el("input", {
    type: "search",
    placeholder: "Search for artwork, e.g. “Hudson River School landscapes”",
  }) as HTMLInputElement;
  inputWrap.append(input);
  const badge = el("span", { class: "chip active" });
  badge.textContent = "via SearXNG";
  row.append(inputWrap, badge);

  const recentHint = el("p", { class: "hint", style: "margin:-8px 0 12px;" });
  recentHint.textContent = "From your recent searches — search above to look for something else.";
  recentHint.hidden = true;

  const grid = el("div", { class: "masonry" });
  const status = el("p", { class: "empty-msg" });
  status.textContent = "Type a search to begin.";

  section.append(heading, description, row, recentHint, status, grid);
  root.replaceChildren(section);

  const entries: MasonryEntry[] = [];
  const disconnect = observe(grid, () => layout(grid, entries, 200));

  let cache = loadCache();

  function removeFromCache(result: DiscoverResult): void {
    let changed = false;
    cache = cache
      .map((batch) => {
        const filtered = batch.results.filter((r) => r.image_url !== result.image_url);
        if (filtered.length !== batch.results.length) changed = true;
        return { ...batch, results: filtered };
      })
      .filter((batch) => batch.results.length > 0);
    if (changed) saveCache(cache);
  }

  function renderResults(results: DiscoverResult[]): void {
    grid.replaceChildren();
    entries.length = 0;
    for (const result of results) grid.append(makeResultCard(result, entries, grid, removeFromCache));
    layout(grid, entries, 200);
  }

  /** Shows the cached photos from recent searches — the state this page opens
   * into, before anything has been typed. */
  function showCached(): void {
    recentHint.hidden = false;
    badge.textContent = "via SearXNG";
    badge.removeAttribute("title");
    const flattened = [...cache].reverse().flatMap((batch) => batch.results);
    if (!flattened.length) {
      recentHint.hidden = true;
      status.hidden = false;
      status.textContent = "Type a search to begin.";
      grid.replaceChildren();
      entries.length = 0;
      return;
    }
    status.hidden = true;
    renderResults(flattened);
  }

  const search = guard(async () => {
    const query = input.value.trim();
    if (!query) {
      showCached();
      return;
    }
    recentHint.hidden = true;
    status.hidden = false;
    status.textContent = "Searching…";
    grid.replaceChildren();
    entries.length = 0;

    const response = await api.discover(query);
    // Show what was actually sent when a template rewrote it, so a template
    // changing the results does not look like the engine misbehaving.
    if (response.expanded_query && response.expanded_query !== query) {
      badge.textContent = `sent: ${response.expanded_query}`;
      badge.title = "Set by your search template in Settings → Discovery";
    } else {
      badge.textContent = "via SearXNG";
      badge.removeAttribute("title");
    }
    if (!response.results.length) {
      status.textContent = "No results.";
      return;
    }
    status.hidden = true;
    renderResults(response.results);

    // Cache this search's first 8 photos, evicting the oldest search once
    // there are more than 8 cached — so the cache never holds more than
    // 8 × 8 = 64 photos.
    cache.push({ query, results: response.results.slice(0, MAX_PHOTOS_PER_SEARCH) });
    if (cache.length > MAX_CACHED_SEARCHES) cache = cache.slice(-MAX_CACHED_SEARCHES);
    saveCache(cache);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") search();
  });
  // Clearing the box back to empty returns to the cached view rather than
  // leaving whatever the last search happened to render on screen.
  input.addEventListener("input", () => {
    if (!input.value.trim()) showCached();
  });

  showCached();

  return () => disconnect();
}

function makeResultCard(
  result: DiscoverResult,
  entries: MasonryEntry[],
  grid: HTMLElement,
  onRemovedFromCache: (result: DiscoverResult) => void,
): HTMLElement {
  const card = el("div", { class: "card" });
  const img = el("img", {
    class: "art",
    src: result.thumbnail_url ?? result.image_url,
    alt: result.title ?? "",
    loading: "lazy",
    referrerpolicy: "no-referrer",
  }) as HTMLImageElement;

  // Remote results usually report dimensions; when they don't, a 3:4 guess keeps
  // the masonry stable and is corrected once the image reports its real size.
  const aspect = result.width && result.height ? result.width / result.height : 0.75;
  img.style.aspectRatio = String(aspect);
  img.style.background = "var(--color-surface-2)";

  const entry: MasonryEntry = { el: card, aspect };
  img.addEventListener("load", () => {
    if (!result.width || !result.height) {
      entry.aspect = img.naturalWidth / img.naturalHeight;
      img.style.aspectRatio = String(entry.aspect);
      layout(grid, entries, 200);
    }
  });
  img.addEventListener("error", () => {
    card.remove();
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    layout(grid, entries, 200);
  });

  const overlay = el("div", { class: "overlay" });
  const saveRow = el("div", { class: "save-row" });
  const save = el("button", { class: "save-btn" }) as HTMLButtonElement;
  save.textContent = "Add";
  const detailBtn = el(
    "button",
    { type: "button", class: "save-btn icon-only", title: "Add with details…", "aria-label": "Add with details…" },
    icon("sliders", true),
  ) as HTMLButtonElement;
  saveRow.append(save, detailBtn);
  overlay.append(saveRow);

  // A single-purpose remove button, not a menu — the only per-card action
  // that made sense here besides adding it (avatar/banner/tags/board all
  // need a saved item and duplicate what "Add with details" already offers)
  // is getting a photo you don't want out of the recent-searches cache.
  const removeWrap = el("div", { class: "kebab-wrap" });
  const removeBtn = el(
    "button",
    { class: "kebab-btn", title: "Remove from cache", "aria-label": "Remove from cache" },
    icon("close", true),
  );
  removeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    onRemovedFromCache(result);
    card.remove();
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    layout(grid, entries, 200);
  });
  removeWrap.append(removeBtn);

  function applySaved(_item: Item, message: string): void {
    save.textContent = "Added";
    save.disabled = true;
    detailBtn.disabled = true;
    detailBtn.title = "Already added";
    toast(message);
  }

  save.addEventListener(
    "click",
    guard(async () => {
      save.disabled = true;
      save.textContent = "Adding…";
      try {
        const saved = await api.saveDiscovered({
          image_url: result.image_url,
          source_url: result.source_url,
          title: result.title,
        });
        applySaved(saved.item, saved.created ? "Added to your collection" : "Already in your collection");
        if (saved.near_duplicate_ids.length) {
          toast(`Looks similar to ${saved.near_duplicate_ids.length} item(s) you already have`);
        }
      } catch (error) {
        save.disabled = false;
        save.textContent = "Add";
        throw error;
      }
    }),
  );
  detailBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openDetailedAddModal(result, (item, created) =>
      applySaved(item, created ? "Added with your details" : "Already in your collection — details updated"),
    );
  });

  card.append(img, overlay, removeWrap);
  entries.push(entry);
  return card;
}

/** The "more questions asked" counterpart to the one-click Add: title, tags
 * and a board, applied right after the save so there is never a saved item
 * with no tags in between. */
function openDetailedAddModal(result: DiscoverResult, onSaved: (item: Item, created: boolean) => void): void {
  const modal = openModal({ maxWidth: "420px" });
  const heading = el("h3");
  heading.textContent = "Add with details";

  const titleLabel = el("label", { style: "display:block;" });
  titleLabel.textContent = "Title";
  const titleInput = el("input", { type: "text" }) as HTMLInputElement;
  titleInput.value = result.title ?? "";

  const tagsLabel = el("label", { style: "display:block; margin-top:12px;" });
  tagsLabel.textContent = "Tags";
  const tagInput = new TagInput({ chips: true, placeholder: "Start typing — suggestions appear as you go" });

  const boardLabel = el("label", { style: "display:block; margin-top:12px;" });
  boardLabel.textContent = "Board (optional)";
  const boardSelect = el("select", { style: "width:100%;" }) as HTMLSelectElement;
  const noneOpt = el("option", { value: "" }) as HTMLOptionElement;
  noneOpt.textContent = "No board";
  boardSelect.append(noneOpt);
  void api.listBoards().then((boards) => {
    for (const board of boards.filter((b) => !b.is_dynamic)) {
      const opt = el("option", { value: String(board.id) }) as HTMLOptionElement;
      opt.textContent = board.name;
      boardSelect.append(opt);
    }
  });

  const submit = el("button", {
    class: "btn btn-filled",
    style: "margin-top:18px; width:100%; justify-content:center;",
  }) as HTMLButtonElement;
  submit.textContent = "Add to collection";

  modal.body.append(heading, titleLabel, titleInput, tagsLabel, tagInput.element, boardLabel, boardSelect, submit);

  submit.addEventListener(
    "click",
    guard(async () => {
      submit.disabled = true;
      try {
        // Whatever is in the field wins, including "nothing" — clearing a
        // pre-filled title is how you save an untitled pin, not an ignored no-op.
        const saved = await api.saveDiscovered({
          image_url: result.image_url,
          source_url: result.source_url,
          title: titleInput.value.trim() || null,
        });
        let item = saved.item;
        const tagNames = [...tagInput.values, tagInput.pending].filter(Boolean);
        if (tagNames.length) {
          item = await api.patchItem(item.id, { tags: [...item.tags.map((t) => t.name), ...tagNames] });
        }
        if (boardSelect.value) {
          await api.bulk({ item_ids: [item.id], action: "add_to_board", board_id: Number(boardSelect.value) });
        }
        onSaved(item, saved.created);
        modal.close();
      } finally {
        submit.disabled = false;
      }
    }),
  );
}
