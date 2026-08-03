/**
 * Item detail modal — architecture §6.4.
 *
 * Image, metadata, tags, recommendations strip, download, crop, delete.
 * Arrow keys move to the next/previous item *within the grid that opened it*,
 * which is why the caller passes the sibling list rather than the modal
 * refetching a page of its own.
 */

import { api } from "../api";
import { icon } from "../icons";
import type { Item } from "../types";
import {
  confirmDialog,
  el,
  formatBytes,
  formatDate,
  guard,
  isTypingTarget,
  openModal,
  serialize,
  tagColor,
  toast,
} from "../ui";
import { openCropModal } from "./cropModal";
import { pickBoard } from "./pickers";
import { TagInput } from "./tagInput";

export interface ItemModalOptions {
  siblings: Item[];
  onDeleted?: (item: Item) => void;
  onChanged?: (item: Item) => void;
}

/**
 * Click-to-edit text. Enter (or blur) saves, Escape reverts.
 *
 * Escape has to stop propagating while editing, or it would close the whole
 * modal — which is the behaviour you want when you are *reading* the item and
 * exactly not what you want when you are half-way through typing a title.
 */
function editableText(config: {
  tag: "h3" | "p";
  value: string | null;
  placeholder: string;
  multiline: boolean;
  onSave: (value: string) => Promise<void>;
}): HTMLElement {
  const node = el(config.tag, { class: "editable", title: "Click to edit" });
  let current = config.value ?? "";

  const paint = () => {
    node.textContent = current || config.placeholder;
    node.classList.toggle("placeholder", !current);
  };
  paint();

  node.addEventListener("click", () => {
    const input = config.multiline
      ? (el("textarea", { rows: "2", style: "width:100%;" }) as HTMLTextAreaElement)
      : (el("input", { type: "text", style: "width:100%;" }) as HTMLInputElement);
    input.value = current;
    node.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const commit = guard(async () => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      input.replaceWith(node);
      if (value !== current) {
        current = value;
        paint();
        await config.onSave(value);
      }
      paint();
    });

    // `input` is a union of two element types, which defeats addEventListener's
    // typed overloads; narrowing the event here is simpler than splitting the
    // two branches apart.
    input.addEventListener("keydown", (event: Event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Enter" && !config.multiline) {
        event.preventDefault();
        commit();
      }
      if (key === "Escape") {
        event.stopPropagation();
        finished = true;
        input.replaceWith(node);
        paint();
      }
    });
    input.addEventListener("blur", () => commit());
  });

  return node;
}

/**
 * System-assigned roles a version can carry, shown as a fixed badge regardless
 * of what the version is named — so "this is the banner" stays visible even if
 * someone renames the file to "Grayscale crop". Keyed on `derivative_target`,
 * which is set by the crop endpoint and never edited by hand.
 */
const ROLE_LABELS: Record<string, string> = {
  avatar: "Profile picture",
  banner: "Banner",
  board_cover: "Board cover",
};

/**
 * The versions strip: every file for this artwork, and which one is shown.
 *
 * Rendered lazily and collapsed to a single line when there is only one file,
 * so an artwork with nothing to choose between does not carry a whole panel
 * about version management.
 */
function buildVersions(item: Item, onChanged: (updated: Item) => void, onCropNew: () => void): HTMLElement {
  // A card by feel, not by a different fill — a border and its own padding
  // are what say "this is its own section", not a background swap.
  const block = el("div", { class: "version-block" });

  const header = el("div", { class: "version-header" });
  const label = el("span", { class: "hint" });
  label.textContent = "Variants";

  const addInput = el("input", { type: "file", accept: "image/*" }) as HTMLInputElement;
  addInput.hidden = true;

  const headerActions = el("div", { class: "version-header-actions" });
  // One click straight into cropping a copy of the main image — no file
  // picker, since there's no file to pick; it's the same freeform crop tool
  // that used to live behind the separate "Crop / resize" action button.
  const plusBtn = el(
    "button",
    { class: "icon-btn", title: "Crop or resize a copy of the main image", "aria-label": "Crop or resize a copy of the main image" },
    icon("plus", true),
  );
  plusBtn.addEventListener("click", () => onCropNew());
  // The file-picker path — an actual different file (a rescan, a higher-res
  // copy), as opposed to a derived crop of what's already here.
  const uploadBtn = el(
    "button",
    { class: "icon-btn", title: "Upload a file as a new variant", "aria-label": "Upload a file as a new variant" },
    icon("upload", true),
  );
  uploadBtn.addEventListener("click", () => addInput.click());
  headerActions.append(plusBtn, uploadBtn);
  header.append(label, headerActions);

  // Hidden by default: with only the artwork's own file, there is no strip
  // to show — see `load()`'s early return below — so the card is just its
  // header row until a second version actually exists.
  const strip = el("div", { class: "version-strip" });
  strip.hidden = true;

  block.append(header, strip, addInput);

  const paint = (data: { canonical_id: number; versions: Item[]; artwork_id: number }) => {
    strip.replaceChildren();
    strip.hidden = false;
    label.textContent =
      data.versions.length > 1 ? `Variants (${data.versions.length})` : "Variants";

    // Selecting a version is a click on its card, not a dedicated button —
    // one fewer thing to click, and it's what every other picker in this app
    // (board covers, tag chips) already does.
    const selectVersion = guard(async (versionId: number) => {
      const updated = await api.setCanonical(data.artwork_id, versionId);
      paint(updated);
      const artwork = await api.getItem(data.artwork_id);
      onChanged(artwork);
      toast("Displayed variant changed");
    });

    for (const version of data.versions) {
      const cell = el("div", { class: "version-cell" });
      const isCanonical = version.id === data.canonical_id;
      const isRoot = version.id === data.artwork_id;
      if (isCanonical) cell.classList.add("canonical");

      const thumb = el("img", { src: version.urls.thumb, alt: "" });
      cell.append(thumb);

      const role = version.derivative_target ? ROLE_LABELS[version.derivative_target] : null;
      if (role) {
        const roleBadge = el("span", { class: "version-badge role" });
        roleBadge.textContent = role;
        cell.append(roleBadge);
      }

      // A free-text name for how this file differs from the artwork's other
      // versions ("Grayscale", "Outline") — click to edit, blank by default for
      // the common case of a plain crop/resize, where the caption below already
      // says enough.
      const name = editableText({
        tag: "p",
        value: version.variant_label,
        placeholder: "Name this variant…",
        multiline: false,
        onSave: async (value) => {
          const updated = await api.patchItem(version.id, { variant_label: value });
          version.variant_label = updated.variant_label;
        },
      });
      name.classList.add("version-name");
      cell.append(name);

      const caption = el("span", { class: "version-caption" });
      caption.textContent = `${version.width}×${version.height} · ${formatBytes(version.filesize)}`;
      cell.append(caption);

      if (isCanonical) {
        const badge = el("span", { class: "version-badge" });
        badge.textContent = "shown";
        cell.append(badge);
      } else {
        // The whole card is the control — clicking it (anywhere but the name
        // field or Delete, both of which have their own click behaviour)
        // switches to this version directly.
        cell.classList.add("selectable");
        cell.title = "Click to show this variant";
        cell.addEventListener("click", (event) => {
          if ((event.target as HTMLElement).closest(".editable, button")) return;
          selectVersion(version.id);
        });
      }

      // The artwork's own file has no delete button here — removing it is
      // "delete the artwork", which cascades to every version and already has
      // its own button (Move to trash) with its own confirmation copy. Every
      // other file is just one of several versions, and can go on its own.
      if (!isRoot) {
        const del = el("button", { class: "btn btn-error-tonal", style: "font-size:11px; padding:4px 8px;" });
        del.textContent = "Delete";
        del.addEventListener(
          "click",
          guard(async () => {
            if (
              !(await confirmDialog(
                "Delete this variant? The artwork's other files are not affected.",
                "Delete variant",
              ))
            ) {
              return;
            }
            await api.deleteItem(version.id);
            toast("Variant deleted");
            await load();
            const artwork = await api.getItem(data.artwork_id);
            onChanged(artwork);
          }),
        );
        cell.append(del);
      }

      strip.append(cell);
    }
  };

  const load = guard(async () => {
    const data = await api.listVersions(item.id);
    // One file and no choice to make: keep the card down to just its header.
    if (data.versions.length <= 1) {
      label.textContent = "Variants";
      strip.replaceChildren();
      strip.hidden = true;
      return;
    }
    paint(data);
  });

  addInput.addEventListener("change", () => {
    const file = addInput.files?.[0];
    addInput.value = "";
    if (!file) return;
    void guard(async () => {
      const data = await api.addVersion(item.id, file);
      paint(data);
      toast("Variant added");
    })();
  });

  void load();
  return block;
}

export function openItemModal(item: Item, options: ItemModalOptions): void {
  let current = item;
  let index = options.siblings.findIndex((i) => i.id === item.id);
  // Tag adds/removes read-then-full-replace the tag list, so two edits fired
  // before the first's response lands would otherwise race — see `serialize`'s
  // doc comment. One queue for the life of this modal is enough: only one
  // item's tags are ever editable on screen at a time.
  const runTagEditSerially = serialize();

  const modal = openModal({ className: "", onClose: () => document.removeEventListener("keydown", onKey) });
  // Distinguishes this modal from every other one sharing `.modal` (confirm
  // dialogs, the crop tool, board settings…) so the mobile bottom-sheet
  // treatment in styles.css lands only here, not on all of them.
  modal.backdrop.classList.add("item-modal-backdrop");
  const imgPane = el("div", { class: "img-pane" });
  const infoPane = el("div", { class: "info-pane" });
  modal.body.remove();
  modal.backdrop.querySelector(".modal")?.classList.add("item-modal");
  modal.backdrop.querySelector(".modal")?.append(imgPane, infoPane);

  function onKey(event: KeyboardEvent): void {
    // Arrow keys move between images only when the user is not typing —
    // otherwise correcting a title with the arrow keys would jump to the next
    // artwork and discard what was being written.
    if (isTypingTarget(event)) return;
    if (!options.siblings.length) return;
    if (event.key === "ArrowRight" && index < options.siblings.length - 1) {
      index += 1;
      render(options.siblings[index]);
    } else if (event.key === "ArrowLeft" && index > 0) {
      index -= 1;
      render(options.siblings[index]);
    }
  }
  document.addEventListener("keydown", onKey);

  // Touch gestures — the mobile equivalent of the arrow-key navigation above
  // and the desktop close button: swipe left/right moves between siblings,
  // swipe down dismisses the modal. Both read from the same `imgPane` a
  // finger would actually be dragging across.
  {
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const SWIPE_THRESHOLD = 60;

    imgPane.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length !== 1) return;
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
        tracking = true;
      },
      { passive: true },
    );
    imgPane.addEventListener(
      "touchend",
      (event) => {
        if (!tracking) return;
        tracking = false;
        const touch = event.changedTouches[0];
        if (!touch) return;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        // Whichever axis moved more decides the gesture, so a mostly-vertical
        // swipe never accidentally triggers a sideways navigation and vice versa.
        if (Math.abs(dy) > Math.abs(dx) && dy > SWIPE_THRESHOLD) {
          modal.close();
        } else if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_THRESHOLD) {
          if (dx < 0 && options.siblings.length && index < options.siblings.length - 1) {
            index += 1;
            render(options.siblings[index]);
          } else if (dx > 0 && options.siblings.length && index > 0) {
            index -= 1;
            render(options.siblings[index]);
          }
        }
      },
      { passive: true },
    );
  }

  function render(next: Item): void {
    current = next;
    imgPane.replaceChildren(
      el("img", { src: next.urls.display, alt: next.title ?? "" }),
    );

    // Title and description are click-to-edit in place rather than living behind
    // an edit mode. Without this the fields were unreachable from the UI at all,
    // which quietly broke two features that depend on them: alphabetical sort
    // and full-text search.
    const heading = editableText({
        tag: "h3",
        value: next.title,
        placeholder: "Untitled — click to name it",
        multiline: false,
        onSave: async (value) => {
          const updated = await api.patchItem(next.id, { title: value });
          Object.assign(next, updated);
          options.onChanged?.(updated);
        },
      });

    const meta = el("p", { class: "meta" });
    meta.textContent = `${next.width} × ${next.height} · ${formatBytes(next.filesize)} · added ${formatDate(next.added_at)}`;

    const description = editableText({
      tag: "p",
      value: next.description,
      placeholder: "Add a description…",
      multiline: true,
      onSave: async (value) => {
        const updated = await api.patchItem(next.id, { description: value });
        Object.assign(next, updated);
        options.onChanged?.(updated);
      },
    });
    description.className = "meta";

    const tagRow = el("div");
    renderTags(tagRow, next);

    const actions = el("div", { class: "actions" });

    // Add to board is the one colored/filled action here — it's the thing you
    // actually come to this row to *do*. Download and Move to trash are
    // simple icon-only buttons instead of matching pills: two same-weight
    // colored buttons next to the real action buried the one that mattered.
    const download = el(
      "a",
      { class: "icon-btn", href: next.urls.download, download: "", title: "Download", "aria-label": "Download" },
      icon("download", true),
    );

    // Citation export (advance.md §10) — a structured, copy-pasteable
    // reference (title, artist tag, added date, source URL) rather than a
    // full BibTeX implementation, which is what turns the collection into
    // something usable as an actual research tool rather than only a visual
    // archive.
    const citationBtn = el(
      "button",
      { class: "icon-btn", type: "button", title: "Copy citation", "aria-label": "Copy citation" },
      icon("quote", true),
    );
    citationBtn.addEventListener(
      "click",
      guard(async () => {
        const citation = await api.itemCitation(next.id);
        try {
          await navigator.clipboard.writeText(citation.text);
          toast("Citation copied to clipboard");
        } catch {
          // Clipboard access can be denied (permissions, insecure context);
          // showing the text directly is the fallback rather than a silent no-op.
          window.prompt("Copy this citation:", citation.text);
        }
      }),
    );

    // Cropping/resizing now starts from the "+" in the Versions section
    // below (one click straight into the tool, on a copy of the main image)
    // rather than a separate action button here duplicating the same trip.
    const openCropOnCopy = () => {
      openCropModal({
        item: next,
        target: null,
        onDone: guard(async () => {
          // Re-read the artwork: the crop is one of its versions now, and it may
          // have become the file being displayed.
          const refreshed = await api.getItem(next.id);
          Object.assign(next, refreshed);
          render(next);
          options.onChanged?.(refreshed);
          toast("New variant created");
        }),
      });
    };

    const addToBoard = el("button", { class: "btn btn-filled" }, `${icon("addBoard", true)} Add to board`);
    addToBoard.addEventListener(
      "click",
      guard(async () => {
        const board = await pickBoard({ excludeDynamic: true });
        if (!board) return;
        await api.bulk({ item_ids: [next.id], action: "add_to_board", board_id: board.id });
        toast(`Added to ${board.name}`);
      }),
    );

    const remove = el(
      "button",
      { class: "icon-btn danger", title: "Move to trash", "aria-label": "Move to trash" },
      icon("trash", true),
    );
    remove.addEventListener(
      "click",
      guard(async () => {
        if (!(await confirmDialog("Move this item to the trash?", "Move to trash"))) return;
        await api.deleteItem(next.id);
        options.onDeleted?.(next);
        toast("Moved to trash", "info", {
          label: "Undo",
          onClick: guard(async () => {
            await api.restoreItem(next.id);
            toast("Restored");
          }),
        });
        modal.close();
      }),
    );

    actions.append(addToBoard, download, citationBtn, remove);

    const versionBlock = buildVersions(
      next,
      (updated) => {
        // Re-render so the main image switches to the newly chosen file.
        Object.assign(next, updated);
        render(next);
        options.onChanged?.(updated);
      },
      openCropOnCopy,
    );

    const recLabel = el("p", { style: "font-size:12.5px; color:var(--color-text-muted); margin-bottom:6px;" });
    recLabel.textContent = "More like this";
    const recStrip = el("div", { class: "rec-strip" });

    // Actions sit last, at the bottom of the pane's content, rather than
    // wedged between the metadata and the versions/recommendations below it.
    infoPane.replaceChildren(heading, meta, description, tagRow, versionBlock, recLabel, recStrip, actions);

    api
      .recommendations(next.id)
      .then((recommended) => {
        if (current.id !== next.id) return;
        if (!recommended.length) {
          recLabel.textContent = "No related items yet — tag a few more and they will show up here.";
          return;
        }
        for (const rec of recommended) {
          const thumb = el("img", { src: rec.urls.thumb, alt: rec.title ?? "" });
          thumb.addEventListener("click", () => render(rec));
          recStrip.append(thumb);
        }
      })
      .catch(() => {
        recLabel.textContent = "Could not load recommendations.";
      });
  }

  function renderTags(container: HTMLElement, target: Item): void {
    container.replaceChildren();
    for (const tag of target.tags) {
      const chip = el("span", { class: "tag-chip" });
      chip.style.background = tagColor(tag);
      if (tag.link_url) {
        // A creator-category tag with a link opens it in a new tab rather
        // than doing nothing — the whole point of storing the link is to
        // actually get somewhere from it.
        const link = el("a", { href: tag.link_url, target: "_blank", rel: "noopener" });
        link.textContent = tag.name;
        link.title = tag.link_url;
        const linkIcon = el("span");
        linkIcon.innerHTML = icon("extlink", true);
        chip.append(link, linkIcon);
      } else {
        chip.textContent = tag.name;
      }
      const removeBtn = el("button", { type: "button", "aria-label": `Remove ${tag.name}` }, "×");
      removeBtn.addEventListener(
        "click",
        guard(() =>
          runTagEditSerially(async () => {
            const updated = await api.patchItem(target.id, {
              tags: target.tags.filter((t) => t.id !== tag.id).map((t) => t.name),
            });
            Object.assign(target, updated);
            renderTags(container, target);
            options.onChanged?.(updated);
          }),
        ),
      );
      chip.append(removeBtn);
      container.append(chip);
    }

    const addTag = el("button", { class: "chip", style: "margin-top:4px;" }, "+ tag");
    addTag.addEventListener("click", () => {
      // Single-shot mode: each pick is applied immediately, so the modal never
      // holds unsaved tag state that a stray Escape could discard.
      const tagInput = new TagInput({
        chips: false,
        placeholder: "tag name",
        onPick: guard((name: string) =>
          runTagEditSerially(async () => {
            const updated = await api.patchItem(target.id, {
              tags: [...target.tags.map((t) => t.name), name],
            });
            Object.assign(target, updated);
            renderTags(container, target);
            options.onChanged?.(updated);
          }),
        ),
      });
      tagInput.element.classList.add("inline");
      addTag.replaceWith(tagInput.element);
      tagInput.focus();
      tagInput.input.addEventListener("blur", () => {
        window.setTimeout(() => {
          if (tagInput.element.isConnected) tagInput.element.replaceWith(addTag);
        }, 200);
      });
    });
    container.append(addTag);
  }

  render(current);
}
