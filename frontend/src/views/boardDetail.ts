/**
 * Board detail — architecture §6.3.
 *
 * Manual boards are drag-reorderable; dynamic boards are a read-only,
 * self-updating grid. Subboard tabs filter within the board. The cover image is
 * deliberately *not* set here — the per-photo ⋮ menu handles it instead
 * (§2b's shared crop mechanism). The search bar is the same `SearchBar`
 * component Feed/Boards use (tag/color/orientation filter dropdown, sort),
 * scoped to this board (and its active subboard, if any) via `board`/
 * `subboard_tag` query params rather than a separate, plainer search box.
 */

import Sortable from "sortablejs";

import { api, ApiError } from "../api";
import { openCropModal } from "../components/cropModal";
import { Grid } from "../components/grid";
import { openItemModal } from "../components/itemModal";
import { pickBoard, openTagsEditorModal, promptTags } from "../components/pickers";
import { createSelect, type CustomSelect } from "../components/select";
import { SearchBar } from "../components/searchBar";
import { createTagsCheckboxDropdown } from "../components/tagsCheckboxDropdown";
import { icon } from "../icons";
import * as router from "../router";
import { store } from "../store";
import type { Board, SortKey, Tag } from "../types";
import { appendModalCloseButton, confirmDialog, el, guard, openModal, renderErrorView, toast, toggleSwitch } from "../ui";

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
  // Grouped so the two sit together as one unit at the header's right edge —
  // and so print's existing `.board-header .row-actions` rule (see
  // styles.css) actually has something to hide, rather than relying only on
  // the blanket `button:not(.print-keep)` rule to catch settingsBtn.
  const headerActions = el("div", { class: "row-actions" });
  headerActions.append(printBtn, settingsBtn);
  header.append(titleBlock, headerActions);

  const subboardTabs = el("div", { class: "subboard-tabs" });

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

  let query = "";
  let sort: SortKey = "added_at";
  const searchBar = new SearchBar({
    initialSort: sort,
    onChange: (nextQuery, nextSort) => {
      query = nextQuery;
      sort = nextSort;
      void grid.reload();
    },
  });

  section.append(header, subboardTabs, searchBar.element, bulkBar);
  root.replaceChildren(section);

  let board: Board | null = null;
  let activeSubboard: number | null = null;
  let sortable: Sortable | null = null;

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
      { action: "delete", label: "Delete photo", icon: "trash", danger: true },
    ],
    fetchPage: (cursor) =>
      api.listItems({
        board: boardId,
        q: query,
        sort,
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
    // Scoped to tags this board's items actually carry — not the full tag
    // list, most of which wouldn't match anything here anyway.
    void api.boardTags(boardId).then((tags) => {
      const active = new Set((board?.subboard_tags ?? []).map((t) => t.id));
      openTagToggleModal(tags, active, async (tag, enabled) => {
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
    if (board) openBoardSettingsModal(board, refreshHeader, () => router.navigate({ view: "boards", sub: "organized" }));
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
  const modal = openModal({ maxWidth: "380px", title: "Subboard tags" });
  const hint = el("p", { class: "hint" });
  hint.textContent = "Activating a tag adds a tab that filters this board down to items carrying it.";
  const list = el("div", { class: "checkbox-list", style: "margin-top:12px;" });
  for (const tag of tags) {
    // Each row is an independent on/off (is THIS tag active as a subboard
    // filter), not a bulk-action "select some of these" checklist -- a
    // toggle switch per row is the right fit, unlike boardModal.ts's tag
    // *selection* list right below, which stays plain checkboxes.
    const row = el("div", { style: "display:flex; align-items:center; gap:8px;" });
    const onToggleChange = guard(async (checked: boolean) => {
      await onToggle(tag, checked);
    });
    const rowSwitch = toggleSwitch(active.has(tag.id), onToggleChange, tag.name);
    row.append(rowSwitch.element, document.createTextNode(tag.name));
    list.append(row);
  }
  if (!tags.length) {
    const empty = el("p", { class: "hint" });
    empty.textContent = "No tags on this board's items yet.";
    list.append(empty);
  }
  modal.body.append(hint, list);
  // Each toggle already commits immediately via `onToggle` -- nothing left
  // to confirm, only dismiss.
  appendModalCloseButton(modal, "Close");
}

/**
 * Board settings — a modal, autosaving field by field (no distinct Save
 * button/state to lose track of), with the footer holding Delete board and
 * Close. The cover image is deliberately not set here — see this file's own
 * doc comment for why — so there is no line about it to explain.
 */
function openBoardSettingsModal(board: Board, onSaved: () => Promise<void>, onDeleted: () => void): void {
  const modal = openModal({ className: "simple-modal-body", maxWidth: "440px", title: "Board settings" });
  // Reassigned after every successful save so the delete confirmation below
  // (and anything else read live rather than only at open time) reflects the
  // latest name, not whatever it was when the modal opened.
  let current = board;

  const nameLabel = el("label");
  nameLabel.textContent = "Name";
  const nameInput = el("input", { type: "text" }) as HTMLInputElement;
  nameInput.value = current.name;

  const descLabel = el("label");
  descLabel.textContent = "Description";
  const descInput = el("textarea") as HTMLTextAreaElement;
  descInput.value = current.description ?? "";

  // "change" (fires on blur/Enter), not "input" -- saves once a field is
  // actually committed rather than on every keystroke, the same convention
  // Settings' own autosaving text fields already use.
  const saveDetails = guard(async () => {
    const name = nameInput.value.trim();
    if (!name) {
      toast("A board needs a name", "error");
      nameInput.value = current.name;
      return;
    }
    current = await api.patchBoard(current.id, { name, description: descInput.value.trim() || null });
    await onSaved();
    toast("Saved");
  });
  nameInput.addEventListener("change", saveDetails);
  descInput.addEventListener("change", saveDetails);

  // A saved-search board's contents are the tags it matches, not a fixed set
  // of pins — this is the same match-mode/tag-checkbox picker boardModal.ts
  // uses at creation, reused here so the query isn't locked in forever.
  let queryBlock: HTMLElement | null = null;
  if (board.is_dynamic) {
    queryBlock = el("div", { style: "margin-top:14px;" });
    const queryLabel = el("label");
    queryLabel.textContent = "Saved-search filters";
    const modeLabel = el("label", { style: "margin-top:10px;" });
    modeLabel.textContent = "Match";
    const tagsLabel = el("label", { style: "margin-top:10px;" });
    tagsLabel.textContent = "Tags";
    const checkedIds = new Set(board.query_tags.map((t) => t.id));
    const tagsDropdown = createTagsCheckboxDropdown(
      store.tags.map((tag) => ({ id: tag.id, name: tag.name })),
      [...checkedIds],
      () => void saveQuery(),
      { emptyMessage: "No tags exist yet." },
    );

    const saveQuery = guard(async () => {
      const tagIds = tagsDropdown.getValues();
      if (!tagIds.length) {
        toast("Pick at least one tag — a saved-search board with no tags matches nothing", "error");
        return;
      }
      const matchMode = modeSelect.getValue() as "all" | "any";
      current = await api.patchBoard(current.id, {
        query_tags: tagIds.map((id) => ({ tag_id: id, match_mode: matchMode })),
      });
      await onSaved();
      toast("Saved");
    });

    const modeSelect: CustomSelect = createSelect(
      [
        { value: "any", label: "Any of these tags (OR)" },
        { value: "all", label: "All of these tags (AND)" },
      ],
      board.match_mode,
      () => void saveQuery(),
      { ariaLabel: "Match" },
    );
    queryBlock.append(queryLabel, modeLabel, modeSelect.element, tagsLabel, tagsDropdown.element);

    void store.loadTags().then(() => {
      tagsDropdown.setItems(store.tags.map((tag) => ({ id: tag.id, name: tag.name })));
    });
  }

  modal.body.append(nameLabel, nameInput, descLabel, descInput);
  if (queryBlock) modal.body.append(queryBlock);

  const deleteBtn = el("button", { class: "delete-link", type: "button" });
  deleteBtn.textContent = "Delete board";
  deleteBtn.addEventListener(
    "click",
    guard(async () => {
      const confirmed = await confirmDialog(
        `Delete the board "${current.name}"? The images in it are not deleted — only the board.`,
        "Delete board",
      );
      if (!confirmed) return;
      await api.deleteBoard(current.id);
      modal.close();
      onDeleted();
      toast("Board deleted");
    }),
  );
  modal.footer.append(deleteBtn);
  appendModalCloseButton(modal, "Close");
}
