/**
 * Crop modal — architecture §2b.
 *
 * One mechanism serves four destinations (avatar, banner, board cover, freeform
 * item crop); `target` only changes the locked aspect ratio and where the
 * resulting derived item gets wired. Adding a fifth destination is a new preset
 * plus a new write target, not new crop infrastructure.
 *
 * Cropper.js rather than a hand-rolled pan/zoom frame specifically because
 * `getData()` returns the selection in *source image pixel coordinates*, which
 * is exactly what POST /api/items/{id}/crop expects. Hand-rolling would mean
 * converting CSS background-position percentages back into image pixels, which
 * is where that kind of code goes wrong.
 */

import Cropper from "cropperjs";
import "cropperjs/dist/cropper.css";

import { api } from "../api";
import { store } from "../store";
import type { CropTarget, Item } from "../types";
import { createSelect } from "./select";
import { appendModalActions, el, guard, openModal, toggleSwitch } from "../ui";

const PRESETS: Record<CropTarget, { title: string; aspect: number; round: boolean }> = {
  avatar: { title: "Crop for avatar", aspect: 1, round: true },
  banner: { title: "Crop for banner", aspect: 3.2, round: false },
  board_cover: { title: "Crop for board cover", aspect: 1.5, round: false },
};

// Ratio choices offered for freeform crops. Presets (avatar/banner/board_cover)
// already lock their own ratio, so this list only ever shows up when
// `target` is null — see the `hidden = !!preset` below.
const RATIO_CHOICES: { label: string; value: string }[] = [
  { label: "Free", value: "" },
  { label: "1:1", value: "1" },
  { label: "4:3", value: String(4 / 3) },
  { label: "3:2", value: String(3 / 2) },
  { label: "16:9", value: String(16 / 9) },
  { label: "3:4 (portrait)", value: String(3 / 4) },
  { label: "9:16 (portrait)", value: String(9 / 16) },
];

export interface CropModalOptions {
  item: Item;
  target: CropTarget | null;
  boardId?: number;
  onDone: (derived: Item) => void;
}

export function openCropModal(options: CropModalOptions): void {
  const preset = options.target ? PRESETS[options.target] : null;
  let cropper: Cropper | null = null;

  const modal = openModal({
    className: "crop-modal-body",
    maxWidth: "560px",
    title: preset ? preset.title : "Crop / resize",
    onClose: () => cropper?.destroy(),
  });

  // `.crop-round` turns Cropper's crop box and its shaded surround into a
  // circle, so the avatar preview shows the shape the avatar will actually be
  // (§2b: "circle for avatar, rounded rect otherwise"). The crop itself is still
  // the square Cropper reports — a circular *mask* is a rendering concern, and
  // the stored derivative stays a normal 1:1 image that the CSS renders round.
  const stage = el("div", { class: `crop-stage-wrap${preset?.round ? " crop-round" : ""}` });
  // The *display* derivative is the crop source shown to the user, but the crop
  // is applied server-side to the original. Cropper reports coordinates in the
  // natural size of whatever image it was given, so the scale factor between the
  // two is applied before sending — otherwise every crop would be silently
  // scaled down by the display/original ratio.
  const image = el("img", { src: options.item.urls.display, alt: "" }) as HTMLImageElement;
  stage.append(image);

  const apply = el("button", { class: "btn btn-filled" }) as HTMLButtonElement;
  apply.textContent = "Apply crop";

  const hint = el("p", { class: "hint", style: "margin-top:12px;" });
  hint.textContent = preset
    ? "Drag to reposition, scroll or pinch to zoom. The aspect ratio is locked for this destination."
    : "Drag to select an area, scroll or pinch to zoom in for a cleaner cut. The original file is never modified — the crop is kept as another variant of this artwork.";

  // Ratio picker — freeform crops only. Presets already lock their aspect via
  // Cropper's own `aspectRatio` option, so offering a second control that could
  // fight it would just be confusing; this row stays hidden whenever `preset`
  // is set.
  const ratioRow = el("div", { class: "field-row", style: "margin-top:12px;" });
  const ratioLabel = el("label", { class: "hint" });
  ratioLabel.textContent = "Ratio";
  // Remembers the last freeform ratio picked across crops in this browser —
  // re-selecting "16:9" every single time you crop a batch of screenshots is
  // exactly the repeat friction "remember last-used context" exists to
  // remove. Cropper itself isn't constructed until the image loads (below),
  // so this only pre-selects the dropdown; the Cropper init reads the same
  // remembered value for its initial `aspectRatio`.
  const rememberedAspect =
    !preset && store.lastCropAspect && RATIO_CHOICES.some((c) => c.value === store.lastCropAspect)
      ? store.lastCropAspect
      : "";
  const ratioSelect = createSelect(RATIO_CHOICES, rememberedAspect, (value) => {
    const ratio = value ? Number(value) : NaN;
    cropper?.setAspectRatio(ratio);
    store.lastCropAspect = value;
  }, { ariaLabel: "Ratio" });
  ratioRow.append(ratioLabel, ratioSelect.element);
  ratioRow.hidden = !!preset;

  // Zoom buttons — a slower, more precise alternative to the scroll/pinch
  // gesture the hint mentions, useful for getting a very clean cut without a
  // trackpad or touchscreen at hand.
  const zoomRow = el("div", { style: "display:flex; gap:8px; align-items:center; margin-top:12px;" });
  const zoomLabel = el("span", { class: "hint" });
  zoomLabel.textContent = "Zoom";
  const zoomOut = el("button", { type: "button", class: "btn btn-outlined", style: "padding:4px 12px;" });
  zoomOut.textContent = "−";
  const zoomIn = el("button", { type: "button", class: "btn btn-outlined", style: "padding:4px 12px;" });
  zoomIn.textContent = "+";
  zoomOut.addEventListener("click", () => cropper?.zoom(-0.1));
  zoomIn.addEventListener("click", () => cropper?.zoom(0.1));
  zoomRow.append(zoomLabel, zoomOut, zoomIn);

  // Freeform crops join the artwork's versions rather than becoming a separate
  // card, so the only question left is which one to display.
  // A plain <div>, not a <label> -- it wraps toggleSwitch()'s own
  // <label class="switch">, and nesting labels is invalid HTML (can
  // double-toggle the input in some browsers).
  const canonicalRow = el("div", {
    class: "hint",
    style: "display:flex; gap:8px; align-items:center; margin-top:12px;",
  });
  const canonicalToggle = toggleSwitch(true, undefined, "Show this crop as the artwork's image");
  canonicalRow.append(canonicalToggle.element, document.createTextNode("Show this crop as the artwork's image"));
  if (preset) canonicalRow.hidden = true;

  // Resize control — the other half of "crop / resize" (§6.4). Offered for every
  // destination, including the aspect-locked ones: an avatar cut from a 4000px
  // scan does not need to be stored at 4000px. Only the width is settable and
  // the height follows from it, so the ratio you selected is exactly the ratio
  // you get.
  const resizeBlock = el("div", { style: "margin-top:14px;" });
  const resizeLabel = el("label");
  const resizeInput = el("input", { type: "range", style: "width:100%;" }) as HTMLInputElement;
  const resizeToggle = el("div", { class: "hint", style: "display:flex; gap:8px; align-items:center;" });
  const resizeSwitch = toggleSwitch(false, undefined, "Also resize the result");
  const resizeCheckbox = resizeSwitch.input;
  resizeToggle.append(resizeSwitch.element, document.createTextNode("Also resize the result"));
  resizeBlock.append(resizeToggle, resizeLabel, resizeInput);
  resizeLabel.hidden = resizeInput.hidden = true;

  const syncResizeLabel = () => {
    const selected = cropper?.getData(true);
    const scale = options.item.width / (image.naturalWidth || options.item.width);
    const naturalWidth = Math.max(1, Math.round((selected?.width ?? options.item.width) * scale));
    resizeInput.max = String(naturalWidth);
    resizeInput.min = String(Math.max(50, Math.round(naturalWidth * 0.1)));
    if (!resizeInput.value || Number(resizeInput.value) > naturalWidth) {
      resizeInput.value = String(naturalWidth);
    }
    // Height is derived, never entered: that is what guarantees the stored image
    // has exactly the ratio that was selected.
    const height = selected ? Math.round((selected.height / selected.width) * Number(resizeInput.value)) : 0;
    // Upscaling is refused by the backend, so the slider simply cannot go above
    // the selection's own size — the constraint is visible rather than an error.
    resizeLabel.textContent = `Output size: ${resizeInput.value} × ${height} px — ratio kept (max ${naturalWidth} wide)`;
  };

  resizeCheckbox.addEventListener("change", () => {
    resizeLabel.hidden = resizeInput.hidden = !resizeCheckbox.checked;
    if (resizeCheckbox.checked) syncResizeLabel();
  });
  resizeInput.addEventListener("input", syncResizeLabel);

  modal.body.append(stage, hint, ratioRow, zoomRow, canonicalRow, resizeBlock);
  appendModalActions(modal, apply);

  image.addEventListener("load", () => {
    cropper = new Cropper(image, {
      // NaN is Cropper's documented way to say "no fixed ratio" — freeform crop.
      aspectRatio: preset ? preset.aspect : rememberedAspect ? Number(rememberedAspect) : NaN,
      viewMode: 1,
      autoCropArea: 0.8,
      background: false,
      responsive: true,
      crop: () => {
        if (resizeCheckbox.checked) syncResizeLabel();
      },
    });
  });

  apply.addEventListener(
    "click",
    guard(async () => {
      if (!cropper) return;
      apply.disabled = true;
      try {
        const data = cropper.getData(true);
        const scale = options.item.width / image.naturalWidth;
        const derived = await api.crop(options.item.id, {
          x: Math.round(data.x * scale),
          y: Math.round(data.y * scale),
          w: Math.round(data.width * scale),
          h: Math.round(data.height * scale),
          target: options.target,
          ...(options.boardId ? { board_id: options.boardId } : {}),
          ...(resizeCheckbox.checked ? { output_width: Number(resizeInput.value) } : {}),
          ...(preset ? {} : { make_canonical: canonicalToggle.input.checked }),
        });
        options.onDone(derived);
        modal.close();
      } finally {
        apply.disabled = false;
      }
    }),
  );
}
