/**
 * Board detail — architecture §6.3.
 *
 * Manual boards are drag-reorderable; dynamic boards are a read-only,
 * self-updating grid. Subboard tabs filter within the board. The cover image is
 * deliberately *not* set here — the per-photo ⋮ menu handles it instead
 * (§2b's shared crop mechanism), which is explained once, briefly, in the
 * board settings drawer rather than as a permanent line on the page itself.
 * What earns a permanent spot on the page instead is a plain search box —
 * no sort/tag/color dropdown like the Feed's, just free text — for finding a
 * pin within this board (or the active subboard).
 */

import Sortable from "sortablejs";

import { api, ApiError } from "../api";
import { openCropModal } from "../components/cropModal";
import { Grid } from "../components/grid";
import { openItemModal } from "../components/itemModal";
import { pickBoard, openTagsEditorModal, promptTags } from "../components/pickers";
import { icon } from "../icons";
import * as router from "../router";
import { store } from "../store";
import type { Board, Tag } from "../types";
import { confirmDialog, el, guard, openModal, renderErrorView, toast } from "../ui";

export function renderBoardDetail(root: HTMLElement, boardId: number): () => void {
  const section = el("section", { class: "view active" });
  const header = el("div", { class: "board-header" });
  const titleBlock = el("div");
  const title = el("h2", { class: "view-title", style: "margin-bottom:2px;" });
  const subtitle = el("p", { class: "view-desc", style: "margin-bottom:0;" });
  titleBlock.append(title, subtitle);
  // A `@media print` stylesheet rather than a real PDF generator (cheap, and
  // sufficient unless it turns out not to be — advance.md §10). "Print"
  // toggles a class the print CSS keys off, injects each visible card's
  // citation text, prints, then tidies up — nothing about the interactive
  // page is left changed afterward.
  const printBtn = el(
    "button",
    { class: "icon-btn print-keep", title: "Print board index", "aria-label": "Print board index" },
    icon("quote", true),
  );
  const settingsBtn = el(
    "button",
    { class: "icon-btn", title: "Board settings", "aria-label": "Board settings" },
    icon("sliders", true),
  );
  header.append(titleBlock, printBtn, settingsBtn);

  const subboardTabs = el("div", { class: "subboard-tabs" });

  // Minimal on purpose: a plain input, no sort/tag/color dropdown like the
  // Feed's search bar carries — this only ever needs to find a pin already
  // known to be in this board (or the active subboard).
  const searchRow = el("div", { class: "search-row", style: "margin: 0 0 14px;" });
  const searchWrap = el("div", { class: "search-input-wrap" }, icon("search", true));
  const searchInput = el("input", { type: "search", placeholder: "Search this board…" }) as HTMLInputElement;
  searchWrap.append(searchInput);
  searchRow.append(searchWrap);

  // Same bulk-select entry point and toolbar as Feed's — "Bulk select" in
  // the ⋮ menu, then a plain click on any card toggles it once at least one
  // is selected. Keeping this consistent across every grid in the app means
  // it only has to be learned once.
  const bulkBar = el("div", { class: "bulk-toolbar" });
  const bulkCount = el("span");
  const bulkTag = el("button", {}, "Add tag");
  const bulkBoard = el("button", {}, "Add to board");
  const bulkDelete = el("button", {}, "Delete");
  const bulkClear = el("button", {}, "Clear");
  bulkBar.append(bulkCount, bulkTag, bulkBoard, bulkDelete, bulkClear);

  section.append(header, subboardTabs, searchRow, bulkBar);
  root.replaceChildren(section);

  let board: Board | null = null;
  let activeSubboard: number | null = null;
  let sortable: Sortable | null = null;
  let query = "";

  const selected = new Set<number>();
  function syncBulk(): void {
    bulkCount.textContent = `${selected.size} selected`;
    bulkBar.classList.toggle("active", selected.size > 0);
    grid.gridElement.classList.toggle("selecting", selected.size > 0);
  }
  function clearSelection(): void {
    selected.clear();
    grid.gridElement.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    syncBulk();
  }

  const grid = new Grid({
    minColumnWidth: 190,
    withSelect: true,
    isSelecting: () => selected.size > 0,
    infiniteScroll: store.settings?.["collection.infinite_scroll"] !== false,
    emptyMessage: "This board is empty.",
    menuActions: [
      { action: "avatar", label: "Set as avatar" },
      { action: "banner", label: "Set as banner" },
      { action: "board_cover", label: "Set as this board's cover" },
      { action: "tags", label: "Edit tags", icon: "tag", dividerBefore: true },
      { action: "add_to_board", label: "Add to board", icon: "addBoard" },
      { action: "delete", label: "Delete photo", icon: "trash" },
    ],
    fetchPage: (cursor) =>
      api.listItems({
        board: boardId,
        q: query,
        cursor,
        ...(activeSubboard ? { subboard_tag: [activeSubboard] } : {}),
      }),
    onOpen: (item) => openItemModal(item, { siblings: grid.items, onDeleted: (i) => grid.removeItem(i.id) }),
    onToggleSelect: (item, isSelected) => {
      if (isSelected) selected.add(item.id);
      else selected.delete(item.id);
      syncBulk();
    },
    onMenuAction: (action, item) => {
      if (action === "avatar" || action === "banner" || action === "board_cover") {
        openCropModal({
          item,
          target: action,
          ...(action === "board_cover" ? { boardId } : {}),
          onDone: guard(async () => {
            if (action === "board_cover") toast("Board cover updated");
            else {
              await store.loadSettings();
              toast(action === "avatar" ? "Avatar updated" : "Banner updated");
            }
            await refreshHeader();
          }),
        });
        return;
      }
      if (action === "tags") {
        openTagsEditorModal(item, (updated) => {
          const index = grid.items.findIndex((i) => i.id === updated.id);
          if (index >= 0) grid.items[index] = updated;
        });
        return;
      }
      if (action === "add_to_board") {
        void guard(async () => {
          const target = await pickBoard({ excludeDynamic: true });
          if (!target) return;
          await api.bulk({ item_ids: [item.id], action: "add_to_board", board_id: target.id });
          toast(`Added to ${target.name}`);
        })();
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
      }
    },
  });
  section.append(grid.element);

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
      const target = await pickBoard({ excludeDynamic: true });
      if (!target) return;
      await api.bulk({ item_ids: [...selected], action: "add_to_board", board_id: target.id });
      clearSelection();
      toast(`Added to ${target.name}`);
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

  async function refreshHeader(): Promise<void> {
    board = await api.getBoard(boardId);
    title.textContent = board.name;
    subtitle.textContent = `${board.description ? `${board.description} · ` : ""}${board.item_count} pins · ${board.is_dynamic ? "dynamic" : "hand-picked"}`;
    renderSubboardTabs();
    setupDragging();
  }

  function renderSubboardTabs(): void {
    subboardTabs.replaceChildren();
    const all = el("span", { class: `chip${activeSubboard === null ? " active" : ""}` });
    all.textContent = "All";
    all.addEventListener("click", () => {
      activeSubboard = null;
      renderSubboardTabs();
      void grid.reload();
    });
    subboardTabs.append(all);

    for (const tag of board?.subboard_tags ?? []) {
      const chip = el("span", { class: `chip${activeSubboard === tag.id ? " active" : ""}` });
      chip.textContent = tag.name;
      chip.addEventListener("click", () => {
        activeSubboard = activeSubboard === tag.id ? null : tag.id;
        renderSubboardTabs();
        void grid.reload();
      });
      subboardTabs.append(chip);
    }

    const add = el("span", {
      class: "chip",
      style: "opacity:.6;",
      title: "Activate a tag as a subboard",
      "aria-label": "Activate a tag as a subboard",
    });
    add.textContent = "+";
    add.addEventListener("click", () => openSubboardPicker());
    subboardTabs.append(add);
  }

  function openSubboardPicker(): void {
    void store.loadTags().then(() => {
      const active = new Set((board?.subboard_tags ?? []).map((t) => t.id));
      openTagToggleModal(store.tags, active, async (tag, enabled) => {
        await api.setSubboardTag(boardId, tag.id, enabled);
        await refreshHeader();
      });
    });
  }

  /**
   * SortableJS needs elements in normal document flow to compute drop targets,
   * but masonry positions every card absolutely. The grid therefore switches to
   * a plain flex layout for the duration of a drag (`.masonry.dragging`) and
   * re-runs the masonry layout on drop. Doing it the other way around — trying
   * to drag absolutely positioned cards — produces drops that land in the wrong
   * place because there is no flow order to read.
   */
  function setupDragging(): void {
    sortable?.destroy();
    sortable = null;
    if (!board || board.is_dynamic) return;

    sortable = Sortable.create(grid.gridElement, {
      animation: 150,
      ghostClass: "sortable-ghost",
      onStart: () => grid.gridElement.classList.add("dragging"),
      onEnd: guard(async () => {
        grid.gridElement.classList.remove("dragging");
        const order = grid.syncOrderFromDom();
        await api.setBoardItems(boardId, order);
        toast("Arrangement saved");
      }),
    });
  }

  settingsBtn.addEventListener("click", () => {
    if (board) openBoardDrawer(board, refreshHeader, () => router.navigate({ view: "boards", sub: "organized" }));
  });

  let searchDebounce: number | undefined;
  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      query = searchInput.value.trim();
      void grid.reload();
    }, 250);
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      window.clearTimeout(searchDebounce);
      query = searchInput.value.trim();
      void grid.reload();
    }
  });

  printBtn.addEventListener(
    "click",
    guard(async () => {
      const citation = await api.boardCitation(boardId);
      const byId = new Map(citation.entries.map((entry) => [entry.item_id, entry]));
      const blocks: HTMLElement[] = [];
      for (const card of Array.from(grid.gridElement.children) as HTMLElement[]) {
        const id = Number(card.dataset.itemId);
        const entry = byId.get(id);
        if (!entry) continue;
        const block = el("div", { class: "print-citation-block" });
        const lines = [entry.title || "Untitled"];
        if (entry.artist) lines.push(`Artist/Creator: ${entry.artist}`);
        if (entry.creation_date) lines.push(`Added: ${entry.creation_date}`);
        if (entry.source) lines.push(`Source: ${entry.source}`);
        block.innerHTML = lines.map((line) => `<div>${line}</div>`).join("");
        card.append(block);
        blocks.push(block);
      }
      grid.gridElement.classList.add("print-citations");
      const cleanup = () => {
        grid.gridElement.classList.remove("print-citations");
        blocks.forEach((b) => b.remove());
        window.removeEventListener("afterprint", cleanup);
      };
      window.addEventListener("afterprint", cleanup);
      window.print();
    }),
  );

  void refreshHeader()
    .then(() => grid.reload())
    .catch((error: unknown) => {
      // A board id from a stale bookmark or a mistyped hash 404s here — a
      // styled "not found" page reads as an intentional response, not a
      // silently broken one.
      if (error instanceof ApiError && error.status === 404) {
        renderErrorView(section, {
          title: "Board not found",
          message: "This board doesn't exist — it may have been deleted.",
          action: { label: "Back to boards", onClick: () => router.navigate({ view: "boards", sub: "organized" }) },
        });
        return;
      }
      toast(error instanceof Error ? error.message : String(error), "error");
    });

  return () => {
    sortable?.destroy();
    grid.destroy();
  };
}

function openTagToggleModal(
  tags: Tag[],
  active: Set<number>,
  onToggle: (tag: Tag, enabled: boolean) => Promise<void>,
): void {
  const modal = openModal({ maxWidth: "380px" });
  const heading = el("h3");
  heading.textContent = "Subboard tags";
  const hint = el("p", { class: "hint" });
  hint.textContent = "Activating a tag adds a tab that filters this board down to items carrying it.";
  const list = el("div", { class: "checkbox-list", style: "margin-top:12px;" });
  for (const tag of tags) {
    const label = el("label");
    const checkbox = el("input", { type: "checkbox" }) as HTMLInputElement;
    checkbox.checked = active.has(tag.id);
    checkbox.addEventListener(
      "change",
      guard(async () => {
        await onToggle(tag, checkbox.checked);
      }),
    );
    label.append(checkbox, document.createTextNode(tag.name));
    list.append(label);
  }
  if (!tags.length) {
    const empty = el("p", { class: "hint" });
    empty.textContent = "No tags yet.";
    list.append(empty);
  }
  modal.body.append(heading, hint, list);
}

function openBoardDrawer(board: Board, onSaved: () => Promise<void>, onDeleted: () => void): void {
  const backdrop = el("div", { class: "drawer-backdrop active" });
  const drawer = el("div", { class: "drawer" });
  const close = el("button", { class: "drawer-close", "aria-label": "Close" }, icon("close"));
  const heading = el("h3");
  heading.textContent = "Board settings";

  const nameLabel = el("label");
  nameLabel.textContent = "Name";
  const nameInput = el("input", { type: "text" }) as HTMLInputElement;
  nameInput.value = board.name;

  const descLabel = el("label");
  descLabel.textContent = "Description";
  const descInput = el("textarea") as HTMLTextAreaElement;
  descInput.value = board.description ?? "";

  const hint = el("div", { class: "drawer-hint" });
  hint.innerHTML =
    'Cover image is set from within the board: open any photo\'s <strong>⋮</strong> menu → "Set as this board\'s cover".';

  const save = el("button", {
    class: "btn btn-filled",
    style: "margin-top:18px; width:100%; justify-content:center;",
  });
  save.textContent = "Save";

  const remove = el("button", {
    class: "btn btn-error-tonal",
    style: "margin-top:10px; width:100%; justify-content:center;",
  });
  remove.textContent = "Delete board";

  drawer.append(close, heading, nameLabel, nameInput, descLabel, descInput, hint, save, remove);
  backdrop.append(drawer);
  document.body.append(backdrop);

  const dismiss = () => backdrop.remove();
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) dismiss();
  });

  save.addEventListener(
    "click",
    guard(async () => {
      await api.patchBoard(board.id, {
        name: nameInput.value.trim(),
        description: descInput.value.trim() || null,
      });
      dismiss();
      await onSaved();
      toast("Board updated");
    }),
  );

  remove.addEventListener(
    "click",
    guard(async () => {
      const confirmed = await confirmDialog(
        `Delete the board "${board.name}"? The images in it are not deleted — only the board.`,
        "Delete board",
      );
      if (!confirmed) return;
      await api.deleteBoard(board.id);
      dismiss();
      onDeleted();
      toast("Board deleted");
    }),
  );
}
