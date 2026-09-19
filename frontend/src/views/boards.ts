/**
 * Boards — the default landing view (architecture §6.2).
 *
 * Profile header, the link-pill row (which is where link management lives; there
 * is no separate link page), then Feed / Boards. "Feed" and "Boards" are the
 * user-facing names; the route/sub values underneath stay "unorganized" and
 * "organized" since that's what the URL, sessionStorage key and backend
 * filters already use.
 */

import { api } from "../api";
import { openBoardCreateModal } from "../components/boardModal";
import { Grid } from "../components/grid";
import { openCropModal } from "../components/cropModal";
import { openItemModal } from "../components/itemModal";
import { openLinkModal } from "../components/linkModal";
import { openTagsEditorModal, pickBoard, promptTags } from "../components/pickers";
import { SearchBar } from "../components/searchBar";
import { icon } from "../icons";
import * as router from "../router";
import { store } from "../store";
import type { Link, SortKey } from "../types";
import { confirmDialog, el, guard, toast } from "../ui";

export interface BoardsViewHandle {
  destroy: () => void;
  /** Switches Feed/Boards without rebuilding the view — see the
   * call site in main.ts for why that distinction matters. */
  setSub: (sub: "unorganized" | "organized") => void;
}

export function renderBoardsView(root: HTMLElement, sub: "unorganized" | "organized"): BoardsViewHandle {
  const section = el("section", { class: "view active" });
  const header = el("div", { class: "profile-header" });
  const banner = el("div", { class: "profile-banner" });
  const avatarWrap = el("div", { class: "profile-avatar-wrap" });
  const avatar = el("div", { class: "profile-avatar" });
  avatarWrap.append(avatar);
  const name = el("h2", { class: "profile-name" });
  const description = el("p", { class: "profile-desc" });
  const links = el("div", { class: "profile-links" });
  header.append(banner, avatarWrap, name, description, links);

  // The Unorganized/Organized toggle itself lives in the topbar (and the
  // mobile bottom bar) now, not in the page body — see main.ts's buildNav.
  // This view only needs to react to which one is current.
  const unorganized = el("div", { class: "subview" });
  const organized = el("div", { class: "subview" });
  section.append(header, unorganized, organized);
  root.replaceChildren(section);

  function applySub(next: "unorganized" | "organized"): void {
    unorganized.classList.toggle("active", next === "unorganized");
    organized.classList.toggle("active", next === "organized");
    // Re-fetches on every arrival, not just the first. With the default
    // Random sort this reshuffles on its own — the backend hands back a
    // fresh `ORDER BY RANDOM()` sample on every request — so no separate
    // "reshuffle" mechanism is needed beyond just reloading.
    if (next === "unorganized") void grid.reload().catch((error: unknown) => toast(String(error), "error"));
  }

  // ---------- profile ----------
  function renderProfile(): void {
    const settings = store.settings;
    name.textContent = settings?.["profile.display_name"] ?? "Art Archive";
    description.textContent = settings?.["profile.description"] || "";
    banner.style.background = settings?.["profile.banner_url"]
      ? `url(${settings["profile.banner_url"]}) center/cover`
      : "linear-gradient(120deg, #6d597a, #457b9d, #264653)";
    avatar.style.background = settings?.["profile.avatar_url"]
      ? `url(${settings["profile.avatar_url"]}) center/cover`
      : "linear-gradient(135deg, #3a5a40, #588157)";
  }

  const renderLinks = guard(async () => {
    const list: Link[] = await api.listLinks();
    links.replaceChildren();
    for (const link of list) {
      const pill = el("a", { class: "link-pill", href: link.url, target: "_blank", rel: "noreferrer noopener" });
      pill.innerHTML = `${icon(link.icon ?? "globe", true)}${link.title}`;
      const edit = el("span", { class: "pill-edit", title: "Edit link" }, icon("sliders", true));
      edit.addEventListener("click", (event) => {
        // The pill is a real anchor so middle-click and "open in new tab" work;
        // only the small edit affordance opens the editor.
        event.preventDefault();
        event.stopPropagation();
        openLinkModal(link, () => renderLinks());
      });
      pill.append(edit);
      links.append(pill);
    }
    const add = el("button", { class: "link-pill add-pill" }, `${icon("plus", true)} Add link`);
    add.addEventListener("click", () => openLinkModal(null, () => renderLinks()));
    links.append(add);
  });

  // ---------- unorganized ----------
  // The tag graph's "View images" button hands a query over through
  // sessionStorage rather than through the URL: the search string is filter
  // state, not a route, and putting it in the hash would make every filter
  // change a history entry to back out of.
  const pendingQuery = sessionStorage.getItem("artboard.pendingQuery") ?? "";
  sessionStorage.removeItem("artboard.pendingQuery");
  // A specific incoming query (from the tag graph) always wins; absent one,
  // fall back to whatever was last searched here rather than always
  // reopening to a blank, unfiltered grid — "remember last-used context"
  // (advance.md §13).
  const initialQuery = pendingQuery || store.lastUnorganizedQuery;

  let query = initialQuery;
  // Feed's default is Random, not whatever Settings → Collection has as the
  // app-wide default sort — that setting is for Boards and search results,
  // where "sorted" means something; Feed is meant to be a shuffled sample, so
  // its own default sort has to actually say Random rather than showing e.g.
  // "Date added" while quietly serving randomized results underneath it.
  let sort: SortKey = "random";

  const searchBar = new SearchBar({
    initialSort: sort,
    initialValue: initialQuery,
    onChange: (nextQuery, nextSort) => {
      query = nextQuery;
      sort = nextSort;
      store.lastUnorganizedQuery = nextQuery;
      void grid.reload().catch((error: unknown) => toast(String(error), "error"));
    },
  });

  const bulkBar = el("div", { class: "bulk-toolbar" });
  const bulkCount = el("span");
  const bulkTag = el("button", {}, "Add tag");
  const bulkBoard = el("button", {}, "Add to board");
  const bulkDelete = el("button", {}, "Delete");
  const bulkClear = el("button", {}, "Clear");
  bulkBar.append(bulkCount, bulkTag, bulkBoard, bulkDelete, bulkClear);

  // Bulk select is a mode, not just "something is currently selected" — it
  // survives a page refresh (sessionStorage) so reloading mid-tagging session
  // doesn't silently drop back into "click opens the image" behaviour. The
  // actual selected ids are not restored (the grid has to refetch its items
  // first), only the mode itself; `selected` starts empty again and the mode
  // is exited by hand via Clear.
  const BULK_MODE_KEY = "pineart.bulkSelectMode.unorganized";
  let bulkMode = sessionStorage.getItem(BULK_MODE_KEY) === "1";
  function setBulkMode(active: boolean): void {
    bulkMode = active;
    try {
      if (active) sessionStorage.setItem(BULK_MODE_KEY, "1");
      else sessionStorage.removeItem(BULK_MODE_KEY);
    } catch {
      /* private mode: losing bulk-select mode across a refresh is a nicety, not a bug */
    }
  }

  const selected = new Set<number>();
  function syncBulk(): void {
    bulkCount.textContent = `${selected.size} selected`;
    bulkBar.classList.toggle("active", bulkMode);
    // Marks the grid while selection mode is on, so the cursor and the
    // permanently-visible checkboxes tell you clicks now select rather than open.
    grid.gridElement.classList.toggle("selecting", bulkMode);
  }
  function clearSelection(): void {
    selected.clear();
    grid.gridElement.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    setBulkMode(false);
    syncBulk();
  }

  const grid = new Grid({
    minColumnWidth: 190,
    withSelect: true,
    infiniteScroll: store.settings?.["collection.infinite_scroll"] !== false,
    // Bulk mode itself gates opening an image, not merely "something is
    // selected" — otherwise deselecting the last item (or restoring the mode
    // after a refresh, before anything is re-selected) would let a plain
    // click open the photo instead of selecting it.
    isSelecting: () => bulkMode,
    emptyMessage: "No items match this search.",
    // Same action set as the board detail's ⋮ menu (minus "set as this
    // board's cover", which only makes sense inside one) — one menu learned
    // once and found everywhere, rather than the Feed's cards offering fewer
    // per-item actions than a board's do.
    menuActions: [
      { action: "avatar", label: "Set as avatar" },
      { action: "banner", label: "Set as banner" },
      { action: "tags", label: "Edit tags", icon: "tag", dividerBefore: true },
      { action: "add_to_board", label: "Add to board", icon: "addBoard" },
      { action: "delete", label: "Delete photo", icon: "trash", danger: true },
    ],
    // Random isn't a real backend sort key — it's the separate `random` flag.
    // The backend hands back a seeded shuffle whose `next_cursor` carries that
    // seed forward, so passing `cursor` through here (not omitting it) is
    // what makes "load more"/infinite scroll continue the same shuffle
    // instead of drawing a brand new one — and therefore repeating items —
    // on every page.
    fetchPage: (cursor) =>
      sort === "random"
        ? api.listItems({ q: query, random: true, cursor })
        : api.listItems({ q: query, sort, cursor }),
    onOpen: (item) => openItemModal(item, { siblings: grid.items, onDeleted: (i) => grid.removeItem(i.id) }),
    onToggleSelect: (item, isSelected) => {
      if (isSelected) {
        selected.add(item.id);
        setBulkMode(true);
      } else {
        selected.delete(item.id);
      }
      syncBulk();
    },
    onMenuAction: (action, item) => {
      if (action === "add_to_board") {
        void guard(async () => {
          const board = await pickBoard({ excludeDynamic: true });
          if (!board) return;
          await api.bulk({ item_ids: [item.id], action: "add_to_board", board_id: board.id });
          toast(`Added to ${board.name}`);
        })();
        return;
      }
      if (action === "tags") {
        openTagsEditorModal(item, (updated) => {
          const index = grid.items.findIndex((i) => i.id === updated.id);
          if (index >= 0) grid.items[index] = updated;
        });
        return;
      }
      if (action === "delete") {
        void guard(async () => {
          if (!(await confirmDialog(`Move "${item.title ?? "this photo"}" to the trash?`, "Move to trash"))) return;
          await api.deleteItem(item.id);
          grid.removeItem(item.id);
          toast("Moved to trash", "info", {
            label: "Undo",
            onClick: guard(async () => {
              await api.restoreItem(item.id);
              void grid.reload();
              toast("Restored");
            }),
          });
        })();
        return;
      }
      openCropModal({
        item,
        target: action as "avatar" | "banner",
        onDone: guard(async () => {
          await store.loadSettings();
          renderProfile();
          toast(action === "avatar" ? "Avatar updated" : "Banner updated");
        }),
      });
    },
  });

  // Reflects a bulk-select mode restored from sessionStorage before anything
  // has been (re-)selected yet.
  syncBulk();

  bulkClear.addEventListener("click", clearSelection);
  bulkTag.addEventListener(
    "click",
    guard(async () => {
      const tags = await promptTags("Tag selected items");
      if (!tags) return;
      await api.bulk({ item_ids: [...selected], action: "tag", tags });
      await store.loadTags();
      clearSelection();
      await grid.reload();
      toast("Tags added");
    }),
  );
  bulkBoard.addEventListener(
    "click",
    guard(async () => {
      const board = await pickBoard({ excludeDynamic: true });
      if (!board) return;
      await api.bulk({ item_ids: [...selected], action: "add_to_board", board_id: board.id });
      clearSelection();
      toast(`Added to ${board.name}`);
    }),
  );
  bulkDelete.addEventListener(
    "click",
    guard(async () => {
      if (!(await confirmDialog(`Move ${selected.size} item(s) to the trash?`, "Move to trash"))) return;
      const ids = [...selected];
      await api.bulk({ item_ids: ids, action: "delete" });
      ids.forEach((id) => grid.removeItem(id));
      clearSelection();
      // Trash already makes this non-destructive for the retention window —
      // an immediate "Undo" is nearly free given that, and is the single
      // biggest trust-builder in an app that touches someone's own files.
      toast(`Moved ${ids.length} item(s) to trash`, "info", {
        label: "Undo",
        onClick: guard(async () => {
          await api.bulk({ item_ids: ids, action: "restore" });
          void grid.reload();
          toast("Restored");
        }),
      });
    }),
  );

  // Useful even though Random is already the default: if the sort has been
  // switched to something else (Alphabetical, Date added…), this jumps back
  // to a fresh random sample without having to reopen the sort dropdown.
  const surprise = el("button", { class: "btn btn-tonal" }, `${icon("shuffle", true)} Surprise me`);
  surprise.addEventListener(
    "click",
    guard(async () => {
      sort = "random";
      searchBar.setSort("random");
      await grid.reload();
    }),
  );
  grid.addFooterAction(surprise);

  unorganized.append(searchBar.element, bulkBar, grid.element);

  // ---------- organized ----------
  const boardsGrid = el("div", { class: "board-grid" });
  organized.append(boardsGrid);

  // Untagged feed: items with zero tags, shown below the board grid so
  // "things that still need organizing" surface right where you're already
  // looking to organize. Same card menu as the unorganized Feed grid above
  // (minus bulk-select, which isn't wired up for this section) so tagging
  // an item here behaves exactly like it does everywhere else.
  const untaggedDivider = el("hr", { class: "section-divider" });
  const untaggedTitle = el("h2", { class: "view-title", style: "margin-top:20px;" }, "Untagged");
  const untaggedGrid = new Grid({
    minColumnWidth: 190,
    infiniteScroll: store.settings?.["collection.infinite_scroll"] !== false,
    emptyMessage: "No untagged items.",
    menuActions: [
      { action: "tags", label: "Edit tags", icon: "tag" },
      { action: "add_to_board", label: "Add to board", icon: "addBoard" },
      { action: "delete", label: "Delete photo", icon: "trash", danger: true },
    ],
    fetchPage: (cursor) => api.untagged(cursor),
    onOpen: (item) =>
      openItemModal(item, { siblings: untaggedGrid.items, onDeleted: (i) => untaggedGrid.removeItem(i.id) }),
    onMenuAction: (action, item) => {
      if (action === "add_to_board") {
        void guard(async () => {
          const board = await pickBoard({ excludeDynamic: true });
          if (!board) return;
          await api.bulk({ item_ids: [item.id], action: "add_to_board", board_id: board.id });
          toast(`Added to ${board.name}`);
        })();
        return;
      }
      if (action === "tags") {
        openTagsEditorModal(item, (updated) => {
          // Tagging the item removes it from "untagged" — drop it from this
          // grid immediately rather than waiting for a reload.
          if (updated.tags.length > 0) untaggedGrid.removeItem(updated.id);
          else {
            const index = untaggedGrid.items.findIndex((i) => i.id === updated.id);
            if (index >= 0) untaggedGrid.items[index] = updated;
          }
        });
        return;
      }
      if (action === "delete") {
        void guard(async () => {
          if (!(await confirmDialog(`Move "${item.title ?? "this photo"}" to the trash?`, "Move to trash"))) return;
          await api.deleteItem(item.id);
          untaggedGrid.removeItem(item.id);
          toast("Moved to trash", "info", {
            label: "Undo",
            onClick: guard(async () => {
              await api.restoreItem(item.id);
              void untaggedGrid.reload();
              toast("Restored");
            }),
          });
        })();
      }
    },
  });
  organized.append(untaggedDivider, untaggedTitle, untaggedGrid.element);

  const renderBoards = guard(async () => {
    const boards = await api.listBoards();
    boardsGrid.replaceChildren();
    for (const [index, board] of boards.entries()) {
      const card = el("div", { class: "board-card" });
      // Same staggered pop-in the pin grid uses (Grid.append's `--card-delay`)
      // instead of every board card appearing at once — one visual language
      // for "a card just arrived" everywhere cards appear.
      card.style.setProperty("--card-delay", `${Math.min(index, 10) * 25}ms`);
      const cover = el("div", { class: "board-cover" });
      if (board.cover_url) cover.style.backgroundImage = `url(${board.cover_url})`;
      const title = el("div", { class: "board-name" });
      title.textContent = board.name;
      if (board.is_dynamic) {
        const badge = el("span", { class: "badge" });
        badge.textContent = "dynamic";
        title.append(badge);
      }
      const count = el("span", { class: "badge" });
      count.textContent = String(board.item_count);
      title.append(count);
      const desc = el("div", { class: "board-desc" });
      desc.textContent = board.description ?? "";
      card.append(cover, title, desc);
      card.addEventListener("click", () => router.navigate({ view: "board", id: board.id }));
      boardsGrid.append(card);
    }

    // Appended directly to the grid, not wrapped: the mockup's dashed
    // "New board" tile is itself a grid cell and lines up with the covers.
    const add = el("button", { class: "new-board-card" }, `${icon("plus")}<span>New board</span>`);
    add.addEventListener("click", () => openBoardCreateModal(() => renderBoards()));
    boardsGrid.append(add);
  });

  // ---------- boot ----------
  renderProfile();
  void renderLinks();
  void renderBoards();
  void untaggedGrid.reload().catch((error: unknown) => toast(String(error), "error"));
  // The Feed grid's first load happens through `applySub` below, not here —
  // it always needs the randomized fetch, never the plain paginated one.

  applySub(pendingQuery ? "unorganized" : sub);
  const unsubscribe = store.subscribe(renderProfile);

  return {
    setSub: applySub,
    destroy: () => {
      unsubscribe();
      grid.destroy();
      untaggedGrid.destroy();
    },
  };
}
