/**
 * A paginated masonry grid.
 *
 * Owns the item list, the masonry layout and the cursor. Pagination is an
 * explicit "Load more" button, never a silent infinite fetch — the architecture
 * adopts Pinterest's masonry reflow but deliberately rejects its infinite scroll.
 */

import { layout, observe, type MasonryEntry } from "../masonry";
import type { Item, ItemPage } from "../types";
import { el, guard } from "../ui";
import { makeCard, type CardOptions } from "./card";

export interface GridOptions extends CardOptions {
  minColumnWidth?: number;
  emptyMessage?: string;
  /** Auto-load the next page when the end of the grid comes into view. */
  infiniteScroll?: boolean;
  /** Fetch one page. `cursor` is null for the first page. */
  fetchPage: (cursor: string | null) => Promise<ItemPage>;
}

export class Grid {
  readonly root: HTMLElement;
  private readonly container: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly loadMoreBtn: HTMLButtonElement;
  private readonly emptyEl: HTMLElement;
  private readonly entries: MasonryEntry[] = [];
  private cursor: string | null = null;
  private disconnect: (() => void) | null = null;
  private sentinelObserver: IntersectionObserver | null = null;
  private readonly sentinel: HTMLElement;
  /** True while a page request is in flight. */
  private loading = false;
  /**
   * Bumped by every reload. A response whose generation is stale is discarded
   * rather than appended: without this, changing the search while a page is in
   * flight lets the old page land on top of the new results.
   */
  private generation = 0;
  /**
   * Ids already on screen. Infinite scroll makes overlapping requests far more
   * likely than a button ever did, and an item arriving twice would be rendered
   * twice — so membership is checked rather than assumed.
   */
  private readonly seen = new Set<number>();
  /** No further pages exist; stops the observer re-requesting the last one. */
  private exhausted = false;
  /** The last card clicked with a modifier key — the anchor a Shift+click
   * range extends from. */
  private lastClickedId: number | null = null;
  /**
   * Guards against the sentinel auto-firing before the caller's own first
   * load ever runs. The sentinel sits in an empty grid, which trivially
   * "intersects" the viewport, so the observer can fire on the very next
   * paint — before a caller who awaits something (e.g. fetching the board's
   * own metadata) ever gets to call `reload()`. When that race lands, the
   * observer's `loadMore()` sets `loading = true` first, so the caller's
   * later `reload()` no-ops against guard #1 in `loadMore()`, and the
   * observer's own response then gets discarded as stale by guard #2 — the
   * net result being zero completed fetches and a grid that never loads
   * until "Load more" is clicked by hand. Observing starts only once the
   * caller has actually completed one load of its own.
   */
  private observing = false;
  items: Item[] = [];
  total = 0;

  constructor(private readonly options: GridOptions) {
    this.root = el("div");
    this.container = el("div", { class: "masonry" });
    this.emptyEl = el("p", { class: "empty-msg" });
    this.emptyEl.hidden = true;
    this.emptyEl.textContent = options.emptyMessage ?? "Nothing here yet.";

    this.loadMoreBtn = el("button", { class: "btn btn-outlined" }) as HTMLButtonElement;
    this.loadMoreBtn.textContent = "Load more";
    this.loadMoreBtn.addEventListener("click", guard(() => this.loadMore()));

    // The mockup puts "Load more" and "Surprise me" side by side in one row
    // under the grid; callers add their own buttons here rather than stacking a
    // second row underneath.
    this.footer = el("div", { style: "display:flex; gap:10px; justify-content:center; margin-top:22px;" });
    this.footer.append(this.loadMoreBtn);

    // The sentinel sits after the grid; when it scrolls into view there is more
    // to fetch. `rootMargin` starts the fetch 600px early so the next page is
    // usually already in place by the time the user reaches the bottom.
    this.sentinel = el("div", { "aria-hidden": "true", style: "height:1px;" });

    this.root.append(this.container, this.emptyEl, this.sentinel, this.footer);
    this.disconnect = observe(this.container, () => this.relayout());

    // Click on empty grid background clears the current bulk selection — the
    // standard "click outside to deselect" pattern. Cards absolutely
    // positioned by the masonry layout leave gutters between them that belong
    // to `this.container` itself, so `event.target === this.container` is
    // true both for a genuine click below/around all the cards *and* for a
    // click in the gap between two cards. Only the former should deselect —
    // so a click is only treated as "outside" the grid when it falls below
    // the bottom edge of every card currently on screen.
    this.container.addEventListener("click", (event) => {
      if (event.target !== this.container || this.marqueeDidDrag) return;
      if (event.clientY < this.contentBottom()) return;
      this.clearSelection();
    });

    if (options.infiniteScroll !== false) {
      this.sentinelObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            void this.loadMore().catch(() => undefined);
          }
        },
        { rootMargin: "600px 0px" },
      );
      // Not `.observe()`d here — see the `observing` field's comment. Started
      // once the caller's first `reload()`/`setItems()` has actually run.
    }

    if (this.options.withSelect) this.wireMarqueeSelect();
  }

  /** True for the click immediately following a marquee drag — set so that
   * click's own empty-background deselect doesn't immediately undo what the
   * drag just selected. */
  private marqueeDidDrag = false;

  /** Click-drag across empty grid area draws a selection box and selects
   * every card it overlaps — the standard file-manager rubber-band pattern,
   * additive to whatever was already selected. */
  private wireMarqueeSelect(): void {
    const MOVE_THRESHOLD = 4;

    this.container.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.target !== this.container) return;
      const containerBox = this.container.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;
      let box: HTMLElement | null = null;

      const onMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
        if (!moved) {
          moved = true;
          this.marqueeDidDrag = true;
          box = el("div", { class: "marquee-box" });
          this.container.append(box);
        }
        const left = Math.min(startX, moveEvent.clientX) - containerBox.left;
        const top = Math.min(startY, moveEvent.clientY) - containerBox.top;
        const width = Math.abs(dx);
        const height = Math.abs(dy);
        box!.style.left = `${left}px`;
        box!.style.top = `${top}px`;
        box!.style.width = `${width}px`;
        box!.style.height = `${height}px`;

        const marqueeRect = box!.getBoundingClientRect();
        for (const entry of this.entries) {
          const cardRect = entry.el.getBoundingClientRect();
          const overlaps = !(
            cardRect.right < marqueeRect.left ||
            cardRect.left > marqueeRect.right ||
            cardRect.bottom < marqueeRect.top ||
            cardRect.top > marqueeRect.bottom
          );
          entry.el.classList.toggle("marquee-hover", overlaps);
        }
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (moved) {
          for (const entry of this.entries) {
            if (!entry.el.classList.contains("marquee-hover")) continue;
            entry.el.classList.remove("marquee-hover");
            if (!entry.el.classList.contains("selected")) {
              entry.el.classList.add("selected");
              const item = this.items[this.entries.indexOf(entry)];
              if (item) this.options.onToggleSelect?.(item, true);
            }
          }
          box?.remove();
          // The click that follows mouseup on the same target must not
          // immediately clear what this drag just selected.
          setTimeout(() => (this.marqueeDidDrag = false), 0);
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  /** Arms the infinite-scroll observer. Idempotent, and safe to call before
   * the observer exists (infiniteScroll: false leaves it null). */
  private startObserving(): void {
    if (this.observing || !this.sentinelObserver) return;
    this.observing = true;
    this.sentinelObserver.observe(this.sentinel);
  }

  get element(): HTMLElement {
    return this.root;
  }

  get gridElement(): HTMLElement {
    return this.container;
  }

  /** Add a button beside "Load more" instead of in a row of its own. */
  addFooterAction(node: HTMLElement): void {
    this.footer.append(node);
  }

  async reload(): Promise<void> {
    this.generation += 1;
    this.cursor = null;
    this.exhausted = false;
    this.items = [];
    this.seen.clear();
    this.entries.length = 0;
    this.container.replaceChildren();
    await this.loadMore();
    this.startObserving();
  }

  async loadMore(): Promise<void> {
    // Two guards, both load-bearing under infinite scroll: `loading` stops the
    // observer firing a second request with the same cursor while the first is
    // still out (which would append the same page twice), and `exhausted` stops
    // it re-requesting the final page forever once the sentinel is permanently
    // on screen.
    if (this.loading || this.exhausted) return;
    this.loading = true;
    const generation = this.generation;
    this.loadMoreBtn.disabled = true;
    try {
      const page = await this.options.fetchPage(this.cursor);
      if (generation !== this.generation) return; // a reload happened meanwhile
      this.total = page.total;
      this.cursor = page.next_cursor;
      this.exhausted = !page.next_cursor;
      this.append(page.items);
      // Only the button disappears when there is nothing more to fetch; the row
      // itself stays so any sibling action (Surprise me) keeps its place.
      this.loadMoreBtn.hidden = this.exhausted;
      this.emptyEl.hidden = this.items.length > 0;
    } finally {
      this.loading = false;
      this.loadMoreBtn.disabled = false;
    }
  }

  /** Adds items already in hand (used by "Surprise me", which is not paginated). */
  setItems(items: Item[], total = items.length): void {
    this.generation += 1;
    this.items = [];
    this.seen.clear();
    this.entries.length = 0;
    this.container.replaceChildren();
    this.cursor = null;
    // "Surprise me" is a complete, unpaginated result: there is nothing after
    // it, so auto-loading must not try to extend it.
    this.exhausted = true;
    this.total = total;
    this.loadMoreBtn.hidden = true;
    this.append(items);
    this.emptyEl.hidden = items.length > 0;
    this.startObserving();
  }

  private append(items: Item[]): void {
    // A staggered fade-in (`.card`'s `card-in` keyframes in styles.css) reads
    // as a deliberate reveal instead of a page population all at once — but
    // only for however many cards land above the fold; the rest are capped to
    // the same small delay so a big "load more" batch still finishes quickly
    // rather than visibly cascading in over a second or two.
    let index = 0;
    for (const item of items) {
      if (this.seen.has(item.id)) continue;
      this.seen.add(item.id);
      const card = makeCard(item, {
        ...this.options,
        onModifierSelect: (clickedItem, event) => this.modifierSelect(clickedItem, event),
      });
      card.style.setProperty("--card-delay", `${Math.min(index, 10) * 25}ms`);
      index += 1;
      this.container.append(card);
      this.entries.push({ el: card, aspect: item.width / item.height });
      this.items.push(item);
    }
    this.relayout();
  }

  /** Shift+click extends a range selection from the last-clicked card to this
   * one; Ctrl/Cmd+click toggles just this one. Both work without first
   * entering "selecting" mode through the ⋮ menu. */
  private modifierSelect(item: Item, event: { shiftKey: boolean }): void {
    const index = this.items.findIndex((i) => i.id === item.id);
    if (index < 0) return;

    if (event.shiftKey && this.lastClickedId !== null) {
      const lastIndex = this.items.findIndex((i) => i.id === this.lastClickedId);
      if (lastIndex >= 0) {
        const [lo, hi] = lastIndex < index ? [lastIndex, index] : [index, lastIndex];
        for (let i = lo; i <= hi; i++) {
          const entry = this.entries[i];
          if (entry && !entry.el.classList.contains("selected")) {
            entry.el.classList.add("selected");
            this.options.onToggleSelect?.(this.items[i], true);
          }
        }
        this.lastClickedId = item.id;
        return;
      }
    }

    const entry = this.entries[index];
    if (entry) {
      const selected = entry.el.classList.toggle("selected");
      this.options.onToggleSelect?.(item, selected);
    }
    this.lastClickedId = item.id;
  }

  /** The lowest bottom edge among all currently rendered cards, in viewport
   * coordinates — used to tell a click below the grid's content apart from a
   * click in a gutter between cards, since both land on `this.container` as
   * their `event.target`. Returns `-Infinity` when the grid is empty, so any
   * click counts as "outside". */
  private contentBottom(): number {
    let maxBottom = -Infinity;
    for (const entry of this.entries) {
      maxBottom = Math.max(maxBottom, entry.el.getBoundingClientRect().bottom);
    }
    return maxBottom;
  }

  /** Clears every selected card and notifies the caller for each — used by
   * both the empty-background click and the marquee's own "start fresh"
   * cases where nothing is being explicitly deselected one at a time. */
  private clearSelection(): void {
    for (const entry of this.entries) {
      if (!entry.el.classList.contains("selected")) continue;
      entry.el.classList.remove("selected");
      const item = this.items[this.entries.indexOf(entry)];
      if (item) this.options.onToggleSelect?.(item, false);
    }
  }

  removeItem(id: number): void {
    const index = this.items.findIndex((i) => i.id === id);
    if (index < 0) return;
    this.seen.delete(id);
    this.items.splice(index, 1);
    const [entry] = this.entries.splice(index, 1);
    this.total = Math.max(0, this.total - 1);
    this.emptyEl.hidden = this.items.length > 0;
    // Fade + shrink out, then relayout so the rest of the grid reflows into
    // the gap — an instant snap on every filter/bulk removal read as the grid
    // glitching rather than as a deliberate reveal (the `card-in` keyframes
    // give arrival the same care). `--transition-fast` matches everything
    // else's timing rather than introducing a one-off duration.
    entry.el.classList.add("card-leaving");
    entry.el.addEventListener(
      "transitionend",
      () => {
        entry.el.remove();
        this.relayout();
      },
      { once: true },
    );
    // Belt-and-braces: if the element was already detached or the transition
    // never fires for some reason (e.g. `display: none` ancestor), the card
    // still has to disappear rather than sit there forever.
    setTimeout(() => {
      if (entry.el.isConnected) {
        entry.el.remove();
        this.relayout();
      }
    }, 260);
    this.relayout();
  }

  /** Re-reads the DOM order into the model — used after a SortableJS drop. */
  syncOrderFromDom(): number[] {
    const order = Array.from(this.container.children).map((child) =>
      Number((child as HTMLElement).dataset.itemId),
    );
    const byId = new Map(this.items.map((item) => [item.id, item]));
    const entryById = new Map(this.entries.map((entry) => [Number(entry.el.dataset.itemId), entry]));
    this.items = order.map((id) => byId.get(id)!).filter(Boolean);
    this.entries.length = 0;
    for (const id of order) {
      const entry = entryById.get(id);
      if (entry) this.entries.push(entry);
    }
    this.relayout();
    return order;
  }

  relayout(): void {
    layout(this.container, this.entries, this.options.minColumnWidth ?? 190);
  }

  destroy(): void {
    this.disconnect?.();
    this.disconnect = null;
    this.sentinelObserver?.disconnect();
    this.sentinelObserver = null;
  }
}
