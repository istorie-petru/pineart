/** Small chooser dialogs shared by the bulk toolbar, the item modal and boards. */

import { api } from "../api";
import { store } from "../store";
import type { Board, Item } from "../types";
import {
  appendModalActions,
  appendModalCloseButton,
  appendTagLabel,
  el,
  guard,
  openModal,
  readableTextColor,
  serialize,
  tagColor,
} from "../ui";
import { TagInput } from "./tagInput";

export function pickBoard(options: { excludeDynamic?: boolean } = {}): Promise<Board | null> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      maxWidth: "400px",
      title: "Add to board",
      onClose: () => {
        if (!settled) resolve(null);
      },
    });
    const list = el("div", { class: "checkbox-list" });
    modal.body.append(list);
    // Clicking a board finishes the picker directly (each button is its own
    // action) -- this is just the one dismiss action for backing out without
    // picking anything, resolving the promise the same way the backdrop/
    // Escape/corner-X already do.
    appendModalCloseButton(modal, "Cancel");

    const finish = (board: Board) => {
      settled = true;
      store.lastBoardId = board.id;
      resolve(board);
      modal.close();
    };

    api
      .listBoards()
      .then((boards) => {
        const usable = options.excludeDynamic ? boards.filter((b) => !b.is_dynamic) : boards;
        if (!usable.length) {
          const empty = el("p", { class: "hint" });
          empty.textContent = options.excludeDynamic
            ? "No manual boards yet. Dynamic boards fill themselves from their tags, so items cannot be added to them by hand."
            : "No boards yet.";
          list.append(empty);
          return;
        }
        // The last board picked sorts first — the common case is adding
        // several batches to the same board in one session, and re-finding
        // it at the bottom of an alphabetical/creation-order list every time
        // is exactly the repeat friction "remember last-used context" exists
        // to remove.
        const lastId = store.lastBoardId;
        const ordered = lastId
          ? [...usable].sort((a, b) => (a.id === lastId ? -1 : b.id === lastId ? 1 : 0))
          : usable;
        for (const board of ordered) {
          const button = el("button", { class: "btn btn-outlined", style: "justify-content:flex-start;" });
          button.textContent =
            board.id === lastId ? `${board.name} · ${board.item_count} (last used)` : `${board.name} · ${board.item_count}`;
          button.addEventListener("click", () => finish(board));
          list.append(button);
        }
      })
      .catch(() => {
        const failed = el("p", { class: "hint" });
        failed.textContent = "Could not load boards.";
        list.append(failed);
      });
  });
}

/** Tag entry with suggestions. Returns null when cancelled. */
export function promptTags(title: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      maxWidth: "420px",
      title,
      onClose: () => {
        if (!settled) resolve(null);
      },
    });
    const label = el("label");
    label.textContent = "Tags";
    const tagInput = new TagInput({ placeholder: "Start typing — suggestions appear as you go" });
    const submit = el("button", { class: "btn btn-filled" });
    submit.textContent = "Apply";

    modal.body.append(label, tagInput.element);
    appendModalActions(modal, submit);
    tagInput.focus();

    const commit = () => {
      // Includes anything typed but not yet turned into a chip.
      const names = [...tagInput.values, tagInput.pending].filter(Boolean);
      if (!names.length) return;
      settled = true;
      resolve(names);
      modal.close();
    };
    submit.addEventListener("click", commit);
  });
}

/**
 * Full add/remove tag editor for one item, opened from a card's ⋮ menu
 * without going through the full item detail modal — the same
 * patch-and-re-render logic the item modal uses for its own tag chips, just
 * standalone so a single click from the grid can reach it.
 */
export function openTagsEditorModal(item: Item, onChanged?: (updated: Item) => void): void {
  const modal = openModal({ maxWidth: "420px", title: "Tags" });
  const chipRow = el("div", { style: "margin: 12px 0;" });
  // Each edit reads-then-full-replaces the tag list; queued so a rapid
  // remove-then-add can't have its second request built from a snapshot the
  // first request's response hasn't updated yet — see `serialize`'s doc
  // comment for the exact failure mode this prevents.
  const runTagEditSerially = serialize();

  function renderChips(target: Item): void {
    chipRow.replaceChildren();
    if (!target.tags.length) {
      const empty = el("span", { class: "hint" });
      empty.textContent = "No tags yet.";
      chipRow.append(empty);
    }
    for (const tag of target.tags) {
      const chip = el("span", { class: "tag-chip" });
      const color = tagColor(tag);
      chip.style.background = color;
      chip.style.color = readableTextColor(color);
      appendTagLabel(chip, tag);
      const removeBtn = el("button", { type: "button", "aria-label": `Remove ${tag.name}` }, "×");
      removeBtn.addEventListener(
        "click",
        guard(() =>
          runTagEditSerially(async () => {
            const updated = await api.patchItem(target.id, {
              tags: target.tags.filter((t) => t.id !== tag.id).map((t) => t.name),
            });
            Object.assign(target, updated);
            renderChips(target);
            onChanged?.(updated);
          }),
        ),
      );
      chip.append(removeBtn);
      chipRow.append(chip);
    }
  }

  const label = el("label");
  label.textContent = "Add a tag";
  const tagInput = new TagInput({
    chips: false,
    placeholder: "tag name",
    onPick: guard((name: string) =>
      runTagEditSerially(async () => {
        const updated = await api.patchItem(item.id, {
          tags: [...item.tags.map((t) => t.name), name],
        });
        Object.assign(item, updated);
        renderChips(item);
        onChanged?.(updated);
      }),
    ),
  });

  renderChips(item);
  modal.body.append(chipRow, label, tagInput.element);
  // Each add/remove already commits via the API immediately -- nothing left
  // to confirm, only dismiss.
  appendModalCloseButton(modal, "Close");
  tagInput.focus();
}
