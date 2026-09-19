/**
 * Confirm an upload, optionally tagging it and filing it to a board.
 *
 * Shown for both the file picker and drag-and-drop, because the moment you are
 * adding images is the moment you know what they are — asking later means
 * finding them again in an untagged pile.
 */

import { api } from "../api";
import type { Board } from "../types";
import { appendModalActions, el, formatBytes, guard, openModal, toast } from "../ui";
import { createSelect } from "./select";
import { TagInput } from "./tagInput";

export interface UploadOutcome {
  created: number;
  duplicates: number;
  /** Filename *and* why it was rejected — a bare filename list leaves the
   * person guessing whether it was a bad format, a corrupt file, or
   * something else; naming the reason is what makes the error actionable
   * (advance.md §6). */
  failed: { filename: string; reason: string }[];
}

export function openUploadDialog(files: File[], onDone: (outcome: UploadOutcome) => void): void {
  const previewUrls: string[] = [];
  const modal = openModal({
    maxWidth: "460px",
    title: files.length === 1 ? "Add 1 image" : `Add ${files.length} images`,
    // Object URLs are revoked on close: a folder import can create hundreds, and
    // each one pins its file in memory until released.
    onClose: () => previewUrls.forEach((url) => URL.revokeObjectURL(url)),
  });

  const total = files.reduce((sum, file) => sum + file.size, 0);
  const summary = el("p", { class: "hint" });
  summary.textContent = `${formatBytes(total)} in total`;

  const strip = el("div", { class: "upload-preview" });
  // Only the first few are previewed; rendering 400 thumbnails to confirm an
  // import is slower than the import itself.
  //
  // Guarded because previews are a convenience, not the point of this dialog: if
  // object URLs are unavailable the upload must still be confirmable rather than
  // the whole dialog failing to open.
  try {
    for (const file of files.slice(0, 8)) {
      const url = URL.createObjectURL(file);
      previewUrls.push(url);
      strip.append(el("img", { src: url, alt: file.name }));
    }
  } catch {
    strip.replaceChildren();
  }
  if (files.length > 8) {
    const more = el("span", { class: "upload-more" });
    more.textContent = `+${files.length - 8}`;
    strip.append(more);
  }

  const tagLabel = el("label");
  tagLabel.textContent = "Tags";
  const tagInput = new TagInput({ placeholder: "Start typing — suggestions appear as you go" });

  const boardLabel = el("label");
  boardLabel.textContent = "Add to board";
  const boardSelect = createSelect([{ value: "", label: "None" }], "", undefined, { ariaLabel: "Add to board" });

  const confirm = el("button", { class: "btn btn-filled" }) as HTMLButtonElement;
  confirm.textContent = "Upload";

  const progress = el("p", { class: "hint", style: "margin-top:10px;" });
  progress.hidden = true;

  modal.body.append(summary, strip, tagLabel, tagInput.element, boardLabel, boardSelect.element, progress);
  const cancel = appendModalActions(modal, confirm);

  void api
    .listBoards()
    .then((boards: Board[]) => {
      boardSelect.addOptions(
        boards.filter((b) => !b.is_dynamic).map((board) => ({ value: String(board.id), label: board.name })),
      );
    })
    .catch(() => undefined);

  confirm.addEventListener(
    "click",
    guard(async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      progress.hidden = false;

      // Anything typed but not committed as a chip still counts — losing a tag
      // because Enter was never pressed would be a nasty little surprise.
      const tags = [...tagInput.values, tagInput.pending].filter(Boolean);
      const boardId = boardSelect.getValue() ? Number(boardSelect.getValue()) : undefined;

      const outcome: UploadOutcome = { created: 0, duplicates: 0, failed: [] };
      const BATCH = 25;
      try {
        for (let index = 0; index < files.length; index += BATCH) {
          progress.textContent = `Uploading ${Math.min(index + BATCH, files.length)} of ${files.length}…`;
          const result = await api.bulkImport(files.slice(index, index + BATCH), {
            tags: tags.join(","),
            boardId,
          });
          outcome.created += result.created.length;
          outcome.duplicates += result.duplicates.length;
          outcome.failed.push(...result.failed.map((entry) => ({ filename: entry.filename, reason: entry.error })));
          // Progress, not just a spinner, for anything bulk (advance.md §6):
          // "134 / 940 imported, 12 duplicates skipped" answers "is this
          // still working" at a scale where an indefinite spinner can't.
          const done = Math.min(index + BATCH, files.length);
          const parts = [`${done} / ${files.length} processed`];
          if (outcome.duplicates) parts.push(`${outcome.duplicates} duplicate(s) skipped`);
          if (outcome.failed.length) parts.push(`${outcome.failed.length} failed`);
          progress.textContent = parts.join(", ");
        }
      } catch (error) {
        confirm.disabled = false;
        cancel.disabled = false;
        progress.hidden = true;
        throw error;
      }

      modal.close();
      onDone(outcome);
    }),
  );

  tagInput.focus();
}

export function reportUpload(outcome: UploadOutcome): void {
  const parts = [`${outcome.created} added`];
  if (outcome.duplicates) parts.push(`${outcome.duplicates} already in the collection`);
  if (outcome.failed.length) parts.push(`${outcome.failed.length} rejected`);
  toast(parts.join(", "));
  if (outcome.failed.length) {
    // Named per file, with the actual reason — "something went wrong" is a
    // trust problem in an app people are storing their own files in
    // (advance.md §6). Capped at 5 so a failed 400-file import doesn't spam
    // the toast stack; the rest is a "…and N more" tail.
    const shown = outcome.failed.slice(0, 5).map((f) => `${f.filename} (${f.reason})`);
    const rest = outcome.failed.length - shown.length;
    toast(`Failed: ${shown.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}`, "error");
  }
}
