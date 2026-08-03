/**
 * Settings — architecture §6.5.
 *
 * Seven tabs. Tag graph, Trash and Backup live here as tabs rather than as
 * top-level nav destinations: none of them is something you open as often as
 * your own collection, so none of them earns a nav slot.
 */

import { api } from "../api";
import { toggleAddImagesMenu } from "../components/addImagesMenu";
import { openCategoryModal } from "../components/categoryModal";
import { Grid } from "../components/grid";
import { openGraphRuleModal } from "../components/graphRuleModal";
import { openItemModal } from "../components/itemModal";
import { DEFAULT_GRAPH_FORCES, renderTagGraph, type TagGraphForces, type TagGraphHandle } from "../components/tagGraph";
import { icon } from "../icons";
import * as router from "../router";
import { store } from "../store";
import type { GraphNode, SortKey, TagCategory } from "../types";
import { confirmDialog, contrastSafeColor, el, guard, toast } from "../ui";

/** Reads the saved physics preference, falling back to the built-in defaults
 * before settings have loaded or if a key is somehow missing. */
function graphForcesFromSettings(): TagGraphForces {
  const settings = store.settings;
  if (!settings) return DEFAULT_GRAPH_FORCES;
  return {
    chargeStrength: settings["tagGraph.charge_strength"] ?? DEFAULT_GRAPH_FORCES.chargeStrength,
    linkDistance: settings["tagGraph.link_distance"] ?? DEFAULT_GRAPH_FORCES.linkDistance,
    linkStrength: settings["tagGraph.link_strength"] ?? DEFAULT_GRAPH_FORCES.linkStrength,
    centerStrength: settings["tagGraph.center_strength"] ?? DEFAULT_GRAPH_FORCES.centerStrength,
  };
}

const TABS: { id: string; label: string; wide?: boolean }[] = [
  { id: "profile", label: "Profile" },
  { id: "appearance", label: "Appearance" },
  { id: "collection", label: "Collection" },
  { id: "tags", label: "Tags", wide: true },
  { id: "discovery", label: "Discovery" },
  { id: "trash", label: "Trash", wide: true },
  { id: "backup", label: "Backup" },
];

export function renderSettings(root: HTMLElement, activeTab: string): () => void {
  const section = el("section", { class: "view active" });
  const headerRow = el("div", { style: "display:flex; align-items:center; justify-content:space-between; gap:12px;" });
  const heading = el("h2", { class: "view-title", style: "margin-bottom:0;" });
  heading.textContent = "Settings";
  // The topbar's Add images icon is hidden entirely on mobile (there's no
  // topbar at all there) — this is that entry point's stand-in, and works
  // identically on desktop too rather than being a mobile-only special case.
  const addImagesBtn = el("button", { class: "btn btn-tonal" }, `${icon("upload", true)} Add images`);
  addImagesBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAddImagesMenu(addImagesBtn);
  });
  headerRow.append(heading, addImagesBtn);
  const tabBar = el("div", { class: "settings-tabs" });
  section.append(headerRow, tabBar);

  const panels = new Map<string, HTMLElement>();
  for (const tab of TABS) {
    const button = el("button", { "data-tab": tab.id });
    button.textContent = tab.label;
    button.addEventListener("click", () => router.navigate({ view: "settings", tab: tab.id }));
    tabBar.append(button);

    const panel = el("div", { class: `settings-panel${tab.wide ? " wide" : ""}` });
    panels.set(tab.id, panel);
    section.append(panel);
  }
  root.replaceChildren(section);

  let graph: TagGraphHandle | null = null;
  let trashGrid: Grid | null = null;

  function activate(tabId: string): void {
    tabBar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
    panels.forEach((panel, id) => panel.classList.toggle("active", id === tabId));
    if (tabId === "tags") void buildTagsPanel();
    if (tabId === "trash") void buildTrashPanel();
  }

  const settings = store.settings;
  if (!settings) {
    heading.textContent = "Settings (loading…)";
    return () => undefined;
  }

  // ---------- Profile ----------
  {
    const panel = panels.get("profile")!;
    const group = el("div", { class: "settings-group" }, "<h4>Display name &amp; description</h4>");
    const col = el("div", { class: "field-col" });
    const nameLabel = el("label");
    nameLabel.textContent = "Name";
    const nameInput = el("input", { type: "text" }) as HTMLInputElement;
    nameInput.value = settings["profile.display_name"];
    const descLabel = el("label");
    descLabel.textContent = "Description";
    const descInput = el("textarea", { rows: "2" }) as HTMLTextAreaElement;
    descInput.value = settings["profile.description"];
    col.append(nameLabel, nameInput, descLabel, descInput);
    const save = el("button", { class: "btn btn-filled" });
    save.textContent = "Save profile";
    save.addEventListener(
      "click",
      guard(async () => {
        await store.saveSettings({
          "profile.display_name": nameInput.value.trim(),
          "profile.description": descInput.value.trim(),
        });
        toast("Profile saved");
      }),
    );
    group.append(col, save);

    const media = el("div", { class: "settings-group" }, "<h4>Avatar &amp; banner</h4>");
    const previewRow = el("div", { class: "preview-row" });
    const miniAvatar = el("div", { class: "mini-avatar" });
    const miniBanner = el("div", { class: "mini-banner" });
    if (settings["profile.avatar_url"]) miniAvatar.style.backgroundImage = `url(${settings["profile.avatar_url"]})`;
    if (settings["profile.banner_url"]) miniBanner.style.backgroundImage = `url(${settings["profile.banner_url"]})`;
    previewRow.append(miniAvatar, miniBanner);
    const hint = el("p", { class: "hint" });
    hint.innerHTML =
      'Set from any photo in your collection: open its <strong>⋮</strong> menu → "Set as avatar" or "Set as banner", then crop.';
    media.append(previewRow, hint);

    panel.append(group, media, buildAccountGroup(), buildResetGroup());
  }

  // ---------- Appearance ----------
  {
    const panel = panels.get("appearance")!;
    const group = el("div", { class: "settings-group" });

    const themeRow = el("div", { class: "field-row" });
    const themeLabel = el("span");
    themeLabel.textContent = "Theme";
    const radioRow = el("div", { class: "radio-row" });
    for (const mode of ["light", "dark", "system"] as const) {
      const label = el("label");
      const radio = el("input", { type: "radio", name: "theme", value: mode }) as HTMLInputElement;
      radio.checked = settings["appearance.theme"] === mode;
      radio.addEventListener(
        "change",
        guard(async () => {
          await store.saveSettings({ "appearance.theme": mode });
        }),
      );
      label.append(radio, document.createTextNode(` ${mode[0].toUpperCase()}${mode.slice(1)}`));
      radioRow.append(label);
    }
    themeRow.append(themeLabel, radioRow);

    const accentRow = el("div", { class: "field-row" });
    const accentLabel = el("span");
    accentLabel.textContent = "Accent color";
    const swatch = el("span", { class: "accent-swatch-btn" });
    swatch.style.background = settings["appearance.accent_color"];
    const picker = el("input", { type: "color" }) as HTMLInputElement;
    picker.value = settings["appearance.accent_color"];
    // Live preview on every input event, but only one write on `change` — a
    // colour picker fires input continuously while dragging, and persisting each
    // frame would be dozens of PUTs per pick.
    picker.addEventListener("input", () => {
      document.documentElement.style.setProperty("--color-accent", picker.value);
      swatch.style.background = picker.value;
    });
    picker.addEventListener(
      "change",
      guard(async () => {
        await store.saveSettings({ "appearance.accent_color": picker.value });
      }),
    );
    swatch.append(picker);
    accentRow.append(accentLabel, swatch);

    group.append(themeRow, accentRow);
    panel.append(group);
  }

  // ---------- Collection ----------
  {
    const panel = panels.get("collection")!;

    const browsing = el("div", { class: "settings-group" }, "<h4>Browsing</h4>");
    const pageRow = el("div", { class: "field-row" });
    const pageLabel = el("span");
    pageLabel.textContent = "Items per page";
    const pageInput = el("input", { type: "number", min: "1", max: "200", style: "width:70px;" }) as HTMLInputElement;
    pageInput.value = String(settings["collection.page_size"]);
    pageInput.addEventListener(
      "change",
      guard(async () => {
        await store.saveSettings({ "collection.page_size": Number(pageInput.value) });
        toast("Saved");
      }),
    );
    pageRow.append(pageLabel, pageInput);

    const scrollRow = toggleRow(
      "Load more automatically while scrolling",
      settings["collection.infinite_scroll"] !== false,
      (value) => store.saveSettings({ "collection.infinite_scroll": value }),
    );
    const scrollHint = el("p", { class: "hint" });
    scrollHint.textContent =
      "With this off, pages are only fetched when you press Load more. Takes effect next time a grid is opened.";

    const sortRow = el("div", { class: "field-row" });
    const sortLabel = el("span");
    sortLabel.textContent = "Default sort";
    const sortSelect = el("select") as HTMLSelectElement;
    for (const [value, label] of [
      ["added_at", "Date added"],
      ["dimensions", "Dimensions"],
      ["filesize", "File size"],
      ["title", "Alphabetical"],
    ] as [SortKey, string][]) {
      const option = el("option", { value }) as HTMLOptionElement;
      option.textContent = label;
      sortSelect.append(option);
    }
    sortSelect.value = settings["collection.default_sort"];
    sortSelect.addEventListener(
      "change",
      guard(async () => {
        await store.saveSettings({ "collection.default_sort": sortSelect.value });
        toast("Saved");
      }),
    );
    sortRow.append(sortLabel, sortSelect);
    browsing.append(pageRow, sortRow, scrollRow, scrollHint);

    const storage = el("div", { class: "settings-group" }, "<h4>Storage</h4>");
    const convert = toggleRow("Convert PNGs to lossless WebP", settings["storage.convert_png_to_webp"], (value) =>
      store.saveSettings({ "storage.convert_png_to_webp": value }),
    );
    const preserve = toggleRow(
      "Preserve exact original bytes",
      settings["storage.preserve_original_bytes"],
      (value) => store.saveSettings({ "storage.preserve_original_bytes": value }),
    );
    const retentionRow = el("div", { class: "field-row" });
    const retentionLabel = el("span");
    retentionLabel.textContent = "Trash retention (days)";
    const retentionInput = el("input", { type: "number", min: "0", style: "width:70px;" }) as HTMLInputElement;
    retentionInput.value = String(settings["storage.trash_retention_days"]);
    retentionInput.addEventListener(
      "change",
      guard(async () => {
        await store.saveSettings({ "storage.trash_retention_days": Number(retentionInput.value) });
        toast("Saved");
      }),
    );
    retentionRow.append(retentionLabel, retentionInput);

    const storageHint = el("p", { class: "hint" });
    storageHint.textContent =
      "These apply to newly added images only — changing them never rewrites files already in your collection.";

    storage.append(convert, preserve, retentionRow, storageHint);
    panel.append(browsing, storage);
  }

  // ---------- Discovery ----------
  {
    const panel = panels.get("discovery")!;
    const group = el("div", { class: "settings-group" });
    const enableRow = toggleRow("Enable Discovery (SearXNG)", settings["discovery.enabled"], async (value) => {
      await store.saveSettings({ "discovery.enabled": value });
      updateStatus();
    });

    const col = el("div", { class: "field-col" });
    const urlLabel = el("label");
    urlLabel.textContent = "SearXNG URL";
    const urlInput = el("input", {
      type: "text",
      placeholder: "http://127.0.0.1:8888",
    }) as HTMLInputElement;
    urlInput.value = settings["discovery.searxng_url"];
    urlInput.addEventListener(
      "change",
      guard(async () => {
        await store.saveSettings({ "discovery.searxng_url": urlInput.value.trim() });
        updateStatus();
        toast("Saved");
      }),
    );
    col.append(urlLabel, urlInput);

    const statusRow = el("div", { class: "field-row" });
    const statusLabel = el("span");
    statusLabel.textContent = "Status";
    const statusValue = el("span", { style: "text-align:right; font-size:12px;" });
    statusRow.append(statusLabel, statusValue);

    const test = el("button", { class: "btn btn-outlined" });
    test.textContent = "Test connection";
    test.addEventListener(
      "click",
      guard(async () => {
        await api.discover("test");
        toast("SearXNG responded");
      }),
    );

    function updateStatus(): void {
      // A green dot when configured, matching the mockup — the state is visible
      // at a glance rather than only readable.
      statusValue.innerHTML = store.discoveryEnabled
        ? '<span class="status-dot"></span>Configured — the Feed tab is visible'
        : "Not configured — the Feed tab stays hidden until this is set up";
    }
    updateStatus();

    group.append(enableRow, col, statusRow, test);
    panel.append(group, buildTemplateGroup());
  }

  // ---------- Tags (graph lives here) ----------
  const tagsPanel = panels.get("tags")!;
  let tagsBuilt = false;

  async function buildTagsPanel(): Promise<void> {
    if (tagsBuilt) return;
    tagsBuilt = true;

    const canvas = el("div", { id: "tagGraph" });

    // ---- Sidebar: the tag editor, categories and rules/physics used to be
    // four separate cards stacked below the graph. They now share one
    // sidebar card next to it, switched between as tabs — one thing open at
    // a time instead of four competing for the same scroll. ----
    const sidebar = el("div", { class: "tags-sidebar" });
    const sidebarTabs = el("div", { class: "tags-sidebar-tabs" });
    const sidebarPanels = new Map<string, HTMLElement>();
    const SIDEBAR_TABS: { id: string; label: string }[] = [
      { id: "edit", label: "Edit tag" },
      { id: "categories", label: "Categories" },
      { id: "rules", label: "Rules & physics" },
      { id: "cleanup", label: "Cleanup" },
    ];
    for (const tab of SIDEBAR_TABS) {
      const button = el("button", { type: "button", "data-tab": tab.id });
      button.textContent = tab.label;
      button.addEventListener("click", () => activateSidebarTab(tab.id));
      sidebarTabs.append(button);
      const panel = el("div", { class: "tags-sidebar-panel" });
      sidebarPanels.set(tab.id, panel);
    }
    function activateSidebarTab(tabId: string): void {
      sidebarTabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
      sidebarPanels.forEach((panel, id) => panel.classList.toggle("active", id === tabId));
    }

    // ---- Graph physics: how spread out and how loosely bonded the layout
    // feels is a matter of taste, not a fixed constant — drag a slider to
    // preview live against the canvas above, release to save. ----
    const physicsHint = el("p", { class: "view-desc", style: "margin-top:0;" });
    physicsHint.textContent = "Drag to preview against the graph above; the value saves when you let go.";

    function sliderRow(
      label: string,
      opts: { min: number; max: number; step: number; format?: (v: number) => string },
    ): { row: HTMLElement; input: HTMLInputElement; readout: HTMLElement } {
      const row = el("div", { class: "field-row" });
      const labelEl = el("span");
      labelEl.textContent = label;
      const wrap = el("div", { class: "slider-wrap" });
      const input = el("input", {
        type: "range",
        min: String(opts.min),
        max: String(opts.max),
        step: String(opts.step),
      }) as HTMLInputElement;
      const readout = el("span", { class: "hint slider-readout" });
      wrap.append(input, readout);
      row.append(labelEl, wrap);
      return { row, input, readout };
    }

    const spread = sliderRow("Spread (repulsion)", { min: -2000, max: -1, step: 10 });
    const distance = sliderRow("Edge length", { min: 10, max: 600, step: 5 });
    const bondStrength = sliderRow("Bond strength", { min: 0, max: 3, step: 0.05 });
    // 0–1 is the actual useful range for a forceX/forceY pull: at 1, each node
    // is already pulled to the center as rigidly as the other forces can
    // meaningfully resist. Values above that just make everything fight charge
    // and collision harder without adding a distinguishable effect.
    const gravity = sliderRow("Center gravity", { min: 0, max: 1, step: 0.05 });
    const resetPhysicsBtn = el("button", { class: "btn btn-outlined", style: "width:100%; justify-content:center; margin-top:6px;" });
    resetPhysicsBtn.textContent = "Reset to defaults";

    function paintPhysicsSliders(forces: TagGraphForces): void {
      spread.input.value = String(forces.chargeStrength);
      spread.readout.textContent = String(forces.chargeStrength);
      distance.input.value = String(forces.linkDistance);
      distance.readout.textContent = String(forces.linkDistance);
      bondStrength.input.value = String(forces.linkStrength);
      bondStrength.readout.textContent = forces.linkStrength.toFixed(2);
      gravity.input.value = String(forces.centerStrength);
      gravity.readout.textContent = forces.centerStrength.toFixed(2);
    }
    paintPhysicsSliders(graphForcesFromSettings());

    function currentSliderForces(): TagGraphForces {
      return {
        chargeStrength: Number(spread.input.value),
        linkDistance: Number(distance.input.value),
        linkStrength: Number(bondStrength.input.value),
        centerStrength: Number(gravity.input.value),
      };
    }

    // Live preview on every tick of the drag, persisted only once the user
    // lets go — sending a PUT per pixel of slider travel would be both
    // wasteful and, since each write re-validates and re-serializes the whole
    // settings blob, needlessly slow.
    for (const { input, readout } of [spread, distance, bondStrength, gravity]) {
      input.addEventListener("input", () => {
        readout.textContent =
          input === bondStrength.input || input === gravity.input
            ? Number(input.value).toFixed(2)
            : input.value;
        graph?.updateForces(currentSliderForces());
      });
      input.addEventListener(
        "change",
        guard(async () => {
          await store.saveSettings({
            "tagGraph.charge_strength": currentSliderForces().chargeStrength,
            "tagGraph.link_distance": currentSliderForces().linkDistance,
            "tagGraph.link_strength": currentSliderForces().linkStrength,
            "tagGraph.center_strength": currentSliderForces().centerStrength,
          });
          toast("Graph physics saved");
        }),
      );
    }

    resetPhysicsBtn.addEventListener(
      "click",
      guard(async () => {
        paintPhysicsSliders(DEFAULT_GRAPH_FORCES);
        graph?.updateForces(DEFAULT_GRAPH_FORCES);
        await store.saveSettings({
          "tagGraph.charge_strength": DEFAULT_GRAPH_FORCES.chargeStrength,
          "tagGraph.link_distance": DEFAULT_GRAPH_FORCES.linkDistance,
          "tagGraph.link_strength": DEFAULT_GRAPH_FORCES.linkStrength,
          "tagGraph.center_strength": DEFAULT_GRAPH_FORCES.centerStrength,
        });
        toast("Graph physics reset");
      }),
    );

    // ---- Tag categories: the supercategories tags can be filed under. Add
    // and edit both go through a modal (categoryModal.ts) rather than an
    // inline form — the sidebar is too narrow for name, color and the links
    // toggle to sit in one row without wrapping awkwardly. The list itself
    // stays put: just a name, an edit button and a remove button per row. ----
    const categoriesHint = el("p", { class: "view-desc", style: "margin-top:0;" });
    categoriesHint.textContent =
      "Group tags into supercategories — Character, Show, Media type, or anything else. A tag's color follows its category unless it has one of its own; board search lists tags under these headings.";
    const categoryListEl = el("div", { class: "sidebar-list" });
    const addCategoryBtn = el("button", {
      class: "btn btn-outlined",
      style: "width:100%; justify-content:center;",
    }, `${icon("plus", true)} Add category`);

    // ---- Graph rules: prune a redundant edge the co-occurrence graph would
    // otherwise draw, e.g. Category=Anime/Show=Haikyu/Character=Hinata on one
    // pin — the direct Anime–Hinata edge adds nothing once Hinata already
    // connects to Haikyu, so a rule removes it. Shares the "Rules & physics"
    // tab with the sliders above. Same modal treatment as categories above. ----
    const rulesHint = el("p", { class: "view-desc", style: "margin-top:0;" });
    rulesHint.textContent =
      'Hide a direct edge between two categories when a tag on one side already connects through a third. Example: don’t connect "Category" to "Character" when that character already connects via "Show".';
    const rulesList = el("div", { class: "sidebar-list" });
    const addRuleBtn = el("button", {
      class: "btn btn-outlined",
      style: "width:100%; justify-content:center;",
    }, `${icon("plus", true)} Add rule`);

    const editor = el("div");
    editor.hidden = true;
    const nameRow = el("div", { class: "field-row" });
    const nameLabel = el("span");
    nameLabel.textContent = "Name";
    const nameInput = el("input", { type: "text", style: "max-width:170px;" }) as HTMLInputElement;
    nameRow.append(nameLabel, nameInput);
    const colorRow = el("div", { class: "field-row" });
    const colorLabel = el("span");
    colorLabel.textContent = "Color";
    const colorInput = el("input", { type: "color" }) as HTMLInputElement;
    colorRow.append(colorLabel, colorInput);
    const categoryRow = el("div", { class: "field-row" });
    const categoryRowLabel = el("span");
    categoryRowLabel.textContent = "Category";
    const categorySelect = el("select", { style: "max-width:170px;" }) as HTMLSelectElement;
    categoryRow.append(categoryRowLabel, categorySelect);
    // Only shown for tags whose category opted in — see `links_enabled` on
    // `TagCategory`. Hidden rather than removed, so toggling a tag's category
    // can show or hide it without rebuilding the row.
    const linkRow = el("div", { class: "field-row" });
    const linkRowLabel = el("span");
    linkRowLabel.textContent = "Link";
    const linkInput = el("input", {
      type: "url",
      placeholder: "https://…",
      style: "max-width:170px;",
    }) as HTMLInputElement;
    linkRow.append(linkRowLabel, linkInput);
    linkRow.hidden = true;

    // Merge: distinct from rename above — rename changes what this tag is
    // called, merge collapses this tag and a different one into a single
    // identity (see advance.md §10, "landscape" / "landscapes"). A plain
    // <select> of every other tag is enough here; this is a maintenance
    // action reached rarely enough that a dedicated picker modal would be
    // more ceremony than the task warrants.
    const mergeRow = el("div", { class: "field-row" });
    const mergeRowLabel = el("span");
    mergeRowLabel.textContent = "Merge into";
    const mergeSelect = el("select", { style: "max-width:170px;" }) as HTMLSelectElement;
    mergeRow.append(mergeRowLabel, mergeSelect);
    const mergeBtn = el("button", {
      class: "btn btn-outlined",
      style: "width:100%; justify-content:center; margin-top:6px;",
    }, `${icon("merge", true)} Merge tag`);

    const viewImages = el("button", {
      class: "btn btn-tonal",
      style: "width:100%; justify-content:center; margin-top:10px;",
    }, `${icon("search", true)} View images`);
    const deleteTagBtn = el("button", {
      class: "btn btn-error-tonal",
      style: "width:100%; justify-content:center; margin-top:10px;",
    }, `${icon("trash", true)} Delete tag`);
    editor.append(nameRow, colorRow, categoryRow, linkRow, mergeRow, mergeBtn, viewImages, deleteTagBtn);

    const emptyHint = el("p", { class: "view-desc", style: "margin-top:0;" });
    emptyHint.textContent = "Click a tag in the graph to edit its name or color, or jump to its filtered collection.";

    sidebarPanels.get("edit")!.append(emptyHint, editor);
    sidebarPanels.get("categories")!.append(categoriesHint, categoryListEl, addCategoryBtn);
    sidebarPanels.get("rules")!.append(
      physicsHint,
      spread.row,
      distance.row,
      bondStrength.row,
      gravity.row,
      resetPhysicsBtn,
      el("div", { class: "tags-sidebar-divider" }),
      rulesHint,
      rulesList,
      addRuleBtn,
    );

    // ---- Cleanup: orphaned tags (zero items, cluttering the filter dropdown
    // and the graph for no reason) and retroactive near-duplicate review
    // (pHash dedup only ever runs at import time — see advance.md §10 — so
    // this is the companion pass over what's already in the collection). ----
    const unusedHint = el("p", { class: "view-desc", style: "margin-top:0;" });
    unusedHint.textContent = "Tags with no items attached. Safe to delete — nothing references them.";
    const unusedList = el("div", { class: "sidebar-list" });
    const refreshUnusedBtn = el("button", {
      class: "btn btn-outlined",
      style: "width:100%; justify-content:center;",
    }, `${icon("refresh", true)} Refresh`);

    async function renderUnusedTags(): Promise<void> {
      unusedList.replaceChildren();
      const unused = await api.unusedTags();
      if (!unused.length) {
        unusedList.append(el("span", { class: "hint" }, "No orphaned tags."));
        return;
      }
      for (const tag of unused) {
        const row = el("div", { class: "sidebar-list-row" });
        const name = el("span", { class: "row-name" });
        name.textContent = tag.name;
        const removeBtn = el(
          "button",
          { type: "button", "aria-label": `Delete ${tag.name}` },
          icon("trash", true),
        );
        removeBtn.addEventListener(
          "click",
          guard(async () => {
            await api.deleteTag(tag.id);
            await renderUnusedTags();
            await store.loadTags();
            toast(`"${tag.name}" deleted`);
          }),
        );
        const actions = el("div", { class: "row-actions" });
        actions.append(removeBtn);
        row.append(name, actions);
        unusedList.append(row);
      }
    }
    refreshUnusedBtn.addEventListener("click", guard(renderUnusedTags));

    const dupeHint = el("p", { class: "view-desc" });
    dupeHint.textContent =
      "Items that entered the collection before perceptual-hash dedup existed, or separate uploads of the same picture, don't get caught automatically. This scans everything currently in the collection for close matches.";
    const dupeList = el("div", { class: "sidebar-list" });
    const scanDupesBtn = el("button", {
      class: "btn btn-outlined",
      style: "width:100%; justify-content:center;",
    }, `${icon("scan", true)} Scan for near-duplicates`);

    async function renderNearDuplicates(): Promise<void> {
      dupeList.replaceChildren(el("span", { class: "hint" }, "Scanning…"));
      const pairs = await api.nearDuplicates();
      dupeList.replaceChildren();
      if (!pairs.length) {
        dupeList.append(el("span", { class: "hint" }, "No near-duplicates found."));
        return;
      }
      for (const pair of pairs) {
        const row = el("div", { class: "dupe-pair" });
        const thumbs = el("div", { class: "dupe-pair-thumbs" });
        for (const item of [pair.a, pair.b]) {
          const img = el("img", { src: item.urls.thumb, loading: "lazy", alt: item.title ?? "" });
          img.addEventListener("click", () => openItemModal(item, { siblings: [pair.a, pair.b] }));
          thumbs.append(img);
        }
        const actions = el("div", { class: "row-actions", style: "margin-top:6px;" });
        const keepA = el("button", { class: "btn btn-outlined" }, "Keep first, trash second");
        keepA.addEventListener(
          "click",
          guard(async () => {
            await api.deleteItem(pair.b.id);
            row.remove();
            toast("Moved to trash");
          }),
        );
        const keepB = el("button", { class: "btn btn-outlined" }, "Keep second, trash first");
        keepB.addEventListener(
          "click",
          guard(async () => {
            await api.deleteItem(pair.a.id);
            row.remove();
            toast("Moved to trash");
          }),
        );
        const keepBoth = el("button", { class: "btn btn-tonal" }, "Keep both");
        keepBoth.addEventListener("click", () => row.remove());
        actions.append(keepA, keepB, keepBoth);
        row.append(thumbs, actions);
        dupeList.append(row);
      }
    }
    scanDupesBtn.addEventListener("click", guard(renderNearDuplicates));

    sidebarPanels.get("cleanup")!.append(
      unusedHint,
      unusedList,
      refreshUnusedBtn,
      el("div", { class: "tags-sidebar-divider" }),
      dupeHint,
      dupeList,
      scanDupesBtn,
    );
    void renderUnusedTags();

    sidebar.append(sidebarTabs, ...sidebarPanels.values());
    activateSidebarTab("edit");

    const graphCol = el("div", { class: "tags-graph-col" });
    graphCol.append(canvas);
    const layout = el("div", { class: "tags-layout" });
    layout.append(graphCol, sidebar);
    tagsPanel.append(layout);

    let categories: TagCategory[] = [];

    /** One row: name (with a colour dot and a link glyph if it allows one),
     * an edit button that opens the modal pre-filled, and a remove button
     * that deletes directly (with confirmation) — no separate delete-inside-
     * the-modal step needed for the common case of just clearing one out. */
    function renderCategoryList(): void {
      categoryListEl.replaceChildren();
      if (!categories.length) {
        const hint = el("span", { class: "hint" });
        hint.textContent = "No categories yet.";
        categoryListEl.append(hint);
        return;
      }
      for (const category of categories) {
        const row = el("div", { class: "sidebar-list-row" });
        const name = el("span", { class: "row-name" });
        const dot = el("span", { class: "tag-dot" });
        dot.style.background = contrastSafeColor(category.color);
        name.append(dot, document.createTextNode(category.name));
        if (category.links_enabled) name.insertAdjacentHTML("beforeend", icon("extlink", true));

        const actions = el("div", { class: "row-actions" });
        const editBtn = el("button", { type: "button", "aria-label": `Edit ${category.name}` }, icon("edit", true));
        editBtn.addEventListener("click", () => {
          openCategoryModal(category, guard(async () => {
            await loadCategories();
            await refreshGraph();
          }));
        });
        const removeBtn = el("button", { type: "button", "aria-label": `Delete ${category.name}` }, icon("trash", true));
        removeBtn.addEventListener(
          "click",
          guard(async () => {
            const ok = await confirmDialog(
              `Delete "${category.name}"? Tags under it become uncategorized — they are not deleted.`,
              "Delete",
            );
            if (!ok) return;
            await api.deleteTagCategory(category.id);
            await loadCategories();
            await refreshGraph();
            toast("Category deleted");
          }),
        );
        actions.append(editBtn, removeBtn);
        row.append(name, actions);
        categoryListEl.append(row);
      }
    }

    function refreshCategorySelect(currentId: number | null | undefined): void {
      categorySelect.replaceChildren();
      const none = el("option", { value: "" }) as HTMLOptionElement;
      none.textContent = "— none —";
      categorySelect.append(none);
      for (const category of categories) {
        const option = el("option", { value: String(category.id) }) as HTMLOptionElement;
        option.textContent = category.name;
        categorySelect.append(option);
      }
      categorySelect.value = currentId ? String(currentId) : "";
    }

    async function renderGraphRules(): Promise<void> {
      rulesList.replaceChildren();
      // A rule needs three *different* categories (from, to, via), so there is
      // nothing meaningful to build until at least that many exist.
      addRuleBtn.disabled = categories.length < 3;
      if (categories.length < 3) {
        const hint = el("span", { class: "hint" });
        hint.textContent = "Add at least three categories to write a rule.";
        rulesList.append(hint);
        return;
      }

      const rules = await api.listGraphRules();
      if (!rules.length) {
        const hint = el("span", { class: "hint" });
        hint.textContent = "No rules yet — every co-occurrence draws an edge.";
        rulesList.append(hint);
        return;
      }
      for (const rule of rules) {
        const row = el("div", { class: "sidebar-list-row" });
        const name = el("span", { class: "row-name" });
        name.textContent = rule.name;

        const actions = el("div", { class: "row-actions" });
        const editBtn = el("button", { type: "button", "aria-label": `Edit ${rule.name}` }, icon("edit", true));
        editBtn.addEventListener("click", () => {
          openGraphRuleModal(rule, categories, guard(async () => {
            await renderGraphRules();
            await refreshGraph();
          }));
        });
        const removeBtn = el("button", { type: "button", "aria-label": `Delete ${rule.name}` }, icon("trash", true));
        removeBtn.addEventListener(
          "click",
          guard(async () => {
            if (!(await confirmDialog(`Delete the "${rule.name}" rule?`, "Delete"))) return;
            await api.deleteGraphRule(rule.id);
            await renderGraphRules();
            await refreshGraph();
            toast("Rule deleted");
          }),
        );
        actions.append(editBtn, removeBtn);
        row.append(name, actions);
        rulesList.append(row);
      }
    }

    addRuleBtn.addEventListener("click", () => {
      openGraphRuleModal(null, categories, guard(async () => {
        await renderGraphRules();
        await refreshGraph();
      }));
    });

    addCategoryBtn.addEventListener("click", () => {
      openCategoryModal(null, guard(async () => {
        await loadCategories();
        await refreshGraph();
      }));
    });

    async function loadCategories(): Promise<void> {
      categories = await api.listTagCategories();
      renderCategoryList();
      if (!editor.hidden) refreshCategorySelect(selectedTag?.category?.id ?? null);
      await renderGraphRules();
    }

    let selectedTag: GraphNode | null = null;
    // A category can be created, renamed or deleted before any tag exists (or
    // while the graph below hasn't been built), and its handlers call this —
    // so it needs a binding that always exists, not a `const` only assigned in
    // the branch below. Reassigned once the graph is actually built.
    let refreshGraph: () => Promise<void> = async () => {};

    const data = await api.tagGraph();
    await loadCategories();
    if (!data.nodes.length) {
      canvas.replaceChildren(
        el("p", { class: "empty-msg" }, "No tags yet — tag a few items and the graph will fill in."),
      );
      return;
    }

    /** Rebuild the graph in place after a structural change (e.g. a rule). */
    refreshGraph = async () => {
      const fresh = await api.tagGraph();
      graph?.destroy();
      graph = renderTagGraph(canvas, fresh, select, graphForcesFromSettings());
    };

    const select = (node: GraphNode) => {
      selectedTag = node;
      editor.hidden = false;
      emptyHint.hidden = true;
      // Clicking a node while looking at Categories or Rules & physics should
      // still bring the fields for it into view, not leave them hidden behind
      // whichever tab happened to be open.
      activateSidebarTab("edit");
      nameInput.value = node.name;
      colorInput.value = node.color ?? "#457b9d";
      refreshCategorySelect(node.category?.id ?? null);
      linkRow.hidden = !node.category?.links_enabled;
      linkInput.value = node.link_url ?? "";

      mergeSelect.replaceChildren();
      for (const other of store.tags) {
        if (other.id === node.id) continue;
        const option = el("option", { value: String(other.id) }) as HTMLOptionElement;
        option.textContent = other.name;
        mergeSelect.append(option);
      }
    };

    graph = renderTagGraph(canvas, data, select, graphForcesFromSettings());

    // Editing updates the node in place, so it is unmistakable which node is
    // being edited without navigating anywhere.
    nameInput.addEventListener(
      "change",
      guard(async () => {
        if (!selectedTag) return;
        const updated = await api.patchTag(selectedTag.id, { name: nameInput.value.trim() });
        graph?.updateNode(selectedTag.id, { name: updated.name });
        selectedTag.name = updated.name;
        await store.loadTags();
        toast("Tag renamed");
      }),
    );
    colorInput.addEventListener(
      "change",
      guard(async () => {
        if (!selectedTag) return;
        const updated = await api.patchTag(selectedTag.id, { color: colorInput.value });
        graph?.updateNode(selectedTag.id, { color: updated.color ?? undefined });
        selectedTag.color = updated.color;
        await store.loadTags();
      }),
    );
    categorySelect.addEventListener(
      "change",
      guard(async () => {
        if (!selectedTag) return;
        const value = categorySelect.value;
        const updated = await api.patchTag(
          selectedTag.id,
          value ? { category_id: Number(value) } : { clear_category: true },
        );
        graph?.updateNode(selectedTag.id, { color: updated.color, category: updated.category });
        selectedTag.category = updated.category;
        linkRow.hidden = !updated.category?.links_enabled;
        await store.loadTags();
        toast("Category updated");
      }),
    );
    linkInput.addEventListener(
      "change",
      guard(async () => {
        if (!selectedTag) return;
        const updated = await api.patchTag(selectedTag.id, { link_url: linkInput.value.trim() });
        selectedTag.link_url = updated.link_url;
        linkInput.value = updated.link_url ?? "";
        await store.loadTags();
        toast("Link updated");
      }),
    );
    viewImages.addEventListener("click", () => {
      if (!selectedTag) return;
      // Writes a `tag:` token into the Unorganized search bar and goes there —
      // the one action in this panel that navigates.
      const slug = store.tags.find((t) => t.id === selectedTag!.id)?.slug ?? selectedTag.name;
      sessionStorage.setItem("artboard.pendingQuery", `tag:${slug}`);
      router.navigate({ view: "boards", sub: "unorganized" });
    });
    mergeBtn.addEventListener(
      "click",
      guard(async () => {
        if (!selectedTag) return;
        const targetId = Number(mergeSelect.value);
        if (!targetId) {
          toast("Add another tag first — there's nothing to merge into yet");
          return;
        }
        const targetName = mergeSelect.selectedOptions[0]?.textContent ?? "that tag";
        const ok = await confirmDialog(
          `Merge "${selectedTag.name}" into "${targetName}"? Every item carrying "${selectedTag.name}" will carry "${targetName}" instead, and "${selectedTag.name}" is deleted. This cannot be undone.`,
          "Merge tag",
        );
        if (!ok) return;
        const result = await api.mergeTag(selectedTag.id, targetId);
        selectedTag = null;
        editor.hidden = true;
        emptyHint.hidden = false;
        await store.loadTags();
        await refreshGraph();
        toast(`Merged — ${result.items_reassigned} item(s) reassigned`);
      }),
    );
    deleteTagBtn.addEventListener(
      "click",
      guard(async () => {
        if (!selectedTag) return;
        // Tags have no trash — this removes the row outright, so the
        // confirmation has to say so plainly rather than borrowing "move to
        // trash" language that would promise an undo the backend doesn't have.
        const ok = await confirmDialog(
          `Permanently delete the "${selectedTag.name}" tag? It is removed from every item that carries it. This cannot be undone.`,
          "Delete tag",
        );
        if (!ok) return;
        await api.deleteTag(selectedTag.id);
        selectedTag = null;
        editor.hidden = true;
        emptyHint.hidden = false;
        await store.loadTags();
        await refreshGraph();
        toast("Tag deleted");
      }),
    );
  }

  // ---------- Trash ----------
  const trashPanel = panels.get("trash")!;
  let trashBuilt = false;

  async function buildTrashPanel(): Promise<void> {
    if (trashBuilt) {
      await trashGrid?.reload();
      return;
    }
    trashBuilt = true;

    const intro = el("p", { class: "view-desc" });
    // Read live rather than from the captured snapshot: the retention window may
    // have been edited in the Collection tab since this view was built.
    const retention = store.settings?.["storage.trash_retention_days"] ?? 30;
    intro.textContent = `Soft-deleted items. Retained ${retention} days (set under Collection → Storage) before permanent purge.`;

    const purgeRow = el("div", { style: "display:flex; gap:10px; margin-bottom:16px;" });
    const purgeExpired = el("button", { class: "btn btn-outlined" });
    purgeExpired.textContent = "Purge expired now";
    const purgeAll = el("button", { class: "btn btn-error-tonal" });
    purgeAll.textContent = "Empty trash";
    purgeRow.append(purgeExpired, purgeAll);

    trashGrid = new Grid({
      minColumnWidth: 190,
      emptyMessage: "The trash is empty.",
      fetchPage: (cursor) => api.trash(cursor),
      extra: (item) => {
        // Restore *and* Purge per card, as in the mockup: the two things you can
        // actually decide about one trashed image, without leaving the grid.
        const actions = el("div", { class: "trash-actions" });
        const restore = el("button", { class: "btn btn-tonal" }, `${icon("restore", true)} Restore`);
        restore.addEventListener(
          "click",
          guard(async () => {
            await api.restoreItem(item.id);
            trashGrid?.removeItem(item.id);
            toast("Restored");
          }),
        );
        const purge = el("button", { class: "btn btn-error-tonal" }, `${icon("trash", true)} Purge`);
        purge.addEventListener(
          "click",
          guard(async () => {
            const ok = await confirmDialog(
              "Permanently delete this image? The file is removed from disk and this cannot be undone.",
              "Delete permanently",
            );
            if (!ok) return;
            await api.purgeItem(item.id);
            trashGrid?.removeItem(item.id);
            toast("Permanently deleted");
          }),
        );
        actions.append(restore, purge);
        return actions;
      },
    });
    trashGrid.gridElement.classList.add("trash-masonry");

    purgeExpired.addEventListener(
      "click",
      guard(async () => {
        const result = await api.purge(false);
        await trashGrid?.reload();
        toast(`Purged ${result.purged} item(s) past the retention window`);
      }),
    );
    purgeAll.addEventListener(
      "click",
      guard(async () => {
        const ok = await confirmDialog(
          "Permanently delete everything in the trash? The image files are removed from disk and this cannot be undone.",
          "Empty trash",
        );
        if (!ok) return;
        const result = await api.purge(true);
        await trashGrid?.reload();
        toast(`Permanently deleted ${result.purged} item(s)`);
      }),
    );

    trashPanel.append(intro, purgeRow, trashGrid.element);
    await trashGrid.reload();
    // Cards in the trash are dimmed until hovered, which is what distinguishes
    // the trash grid from the collection at a glance.
    trashGrid.gridElement.querySelectorAll(".card").forEach((card) => card.classList.add("trash-card"));
  }

  // ---------- Backup ----------
  {
    const panel = panels.get("backup")!;
    const group = el("div", { class: "settings-group" });

    const exportRow = el("div", { class: "field-row" });
    const exportLabel = el("span");
    exportLabel.textContent = "Full export (database + image files)";
    const exportLink = el("a", { class: "btn btn-tonal", href: api.exportUrl, download: "" });
    exportLink.innerHTML = `${icon("download", true)} Export`;
    exportRow.append(exportLabel, exportLink);

    const importRow = el("div", { class: "field-row" });
    const importLabel = el("span");
    importLabel.textContent = "Import from an export archive";
    const importInput = el("input", { type: "file", accept: ".zip" }) as HTMLInputElement;
    importInput.hidden = true;
    const importBtn = el("button", { class: "btn btn-outlined" }, `${icon("upload", true)} Import`);
    importBtn.addEventListener("click", () => importInput.click());
    importInput.addEventListener(
      "change",
      guard(async () => {
        const file = importInput.files?.[0];
        if (!file) return;
        toast("Importing…");
        const result = await api.importArchive(file);
        importInput.value = "";
        toast(
          `Imported ${result.items_imported} item(s), ${result.boards_imported} board(s); ${result.skipped} already present`,
        );
      }),
    );
    importRow.append(importLabel, importBtn);

    const hint = el("p", { class: "hint" });
    hint.textContent =
      "Import is keyed on image content, so re-importing an archive you already have is a no-op rather than a duplication.";

    const encryptionHint = el("p", { class: "hint" });
    encryptionHint.textContent =
      "An export is a full, unencrypted copy of your collection. Fine to keep on this machine — if you move a copy off this box (another drive, cloud storage, anywhere else), encrypt it there. Nothing here does that automatically.";

    group.append(exportRow, importRow, importInput, hint, encryptionHint);
    panel.append(group);

    // A visible version string is the one-line fix for "beta software is
    // software where nobody — including its author — can say confidently
    // what's actually running" (advance.md §8). Read from /api/health rather
    // than baked in at build time, so it can never drift from what the
    // running backend actually reports.
    const versionRow = el("p", { class: "hint", style: "margin-top:18px;" });
    versionRow.textContent = "Checking version…";
    panel.append(versionRow);
    void api
      .health()
      .then((status) => {
        versionRow.textContent = `Artboard v${status.version}`;
      })
      .catch(() => {
        versionRow.textContent = "Version unavailable — could not reach the backend.";
      });
  }

  activate(activeTab);

  return () => {
    graph?.destroy();
    trashGrid?.destroy();
  };
}

/**
 * Search templates for Discovery.
 *
 * The Feed's search box should take the subject and nothing else — "Shōyō
 * Hinata", not "Shōyō Hinata artwork high resolution -pinterest". The template
 * holds that boilerplate once, `{query}` marks where the subject goes, and the
 * backend expands it. Recommended templates are shown as plain selectable text
 * so they can be copied, edited and saved rather than only picked from a list.
 */
function buildTemplateGroup(): HTMLElement {
  const group = el("div", { class: "settings-group" }, "<h4>Search template</h4>");

  const intro = el("p", { class: "hint" });
  intro.textContent =
    "Applied to everything you search in the Feed. Use {query} where your search terms should go.";

  const activeInput = el("input", {
    type: "text",
    style: "width:100%; margin-top:10px;",
    placeholder: "{query} artwork",
  }) as HTMLInputElement;

  const preview = el("p", { class: "hint", style: "margin-top:6px;" });
  const renderPreview = () => {
    const template = activeInput.value.trim() || "{query}";
    preview.textContent = template.includes("{query}")
      ? `Searching "Shōyō Hinata" would send: ${template.replace("{query}", "Shōyō Hinata")}`
      : "The template must contain {query}, or your search terms would be dropped.";
  };
  activeInput.addEventListener("input", renderPreview);
  activeInput.addEventListener(
    "change",
    guard(async () => {
      await store.saveSettings({ "discovery.query_template": activeInput.value.trim() || "{query}" });
      toast("Search template saved");
    }),
  );

  const savedLabel = el("p", { class: "hint", style: "margin-top:16px; font-weight:600;" });
  savedLabel.textContent = "Your templates";
  const savedList = el("div", { class: "template-list" });

  const addRow = el("div", { style: "display:flex; gap:8px; margin-top:10px;" });
  const nameInput = el("input", { type: "text", placeholder: "Name", style: "flex:1;" }) as HTMLInputElement;
  const templateInput = el("input", {
    type: "text",
    placeholder: "{query} artwork",
    style: "flex:2;",
  }) as HTMLInputElement;
  const addBtn = el("button", { class: "btn btn-tonal" });
  addBtn.textContent = "Save";
  addRow.append(nameInput, templateInput, addBtn);

  const recommendedLabel = el("p", { class: "hint", style: "margin-top:18px; font-weight:600;" });
  recommendedLabel.textContent = "Recommended — copy, edit, or use as-is";
  const recommendedList = el("div", { class: "template-list" });

  group.append(intro, activeInput, preview, savedLabel, savedList, addRow, recommendedLabel, recommendedList);

  const renderTemplates = guard(async () => {
    const data = await api.discoveryTemplates();
    activeInput.value = data.active || "{query}";
    renderPreview();

    savedList.replaceChildren();
    if (!data.saved.length) {
      const empty = el("p", { class: "hint" });
      empty.textContent = "None saved yet.";
      savedList.append(empty);
    }
    for (const entry of data.saved) {
      const row = el("div", { class: "template-row" });
      const text = el("div");
      const name = el("strong");
      name.textContent = entry.name;
      const code = el("code");
      code.textContent = entry.template;
      text.append(name, document.createElement("br"), code);

      const use = el("button", { class: "btn btn-outlined" });
      use.textContent = "Use";
      use.addEventListener(
        "click",
        guard(async () => {
          await store.saveSettings({ "discovery.query_template": entry.template });
          activeInput.value = entry.template;
          renderPreview();
          toast(`Using "${entry.name}"`);
        }),
      );

      const remove = el("button", { class: "btn btn-error-tonal" });
      remove.textContent = "Delete";
      remove.addEventListener(
        "click",
        guard(async () => {
          await store.saveSettings({
            "discovery.templates": data.saved.filter((t) => t.name !== entry.name),
          });
          await renderTemplates();
        }),
      );

      row.append(text, use, remove);
      savedList.append(row);
    }

    recommendedList.replaceChildren();
    for (const entry of data.recommended) {
      const row = el("div", { class: "template-row" });
      const text = el("div");
      const name = el("strong");
      name.textContent = entry.name;
      const code = el("code");
      // Selectable text, so it can be copied and edited by hand — the point of
      // showing these rather than hiding them behind a dropdown.
      code.textContent = entry.template;
      const note = el("span", { class: "hint" });
      note.textContent = entry.note;
      text.append(name, document.createElement("br"), code, document.createElement("br"), note);

      const use = el("button", { class: "btn btn-outlined" });
      use.textContent = "Use";
      use.addEventListener(
        "click",
        guard(async () => {
          await store.saveSettings({ "discovery.query_template": entry.template });
          activeInput.value = entry.template;
          renderPreview();
          toast(`Using "${entry.name}"`);
        }),
      );

      const save = el("button", { class: "btn btn-tonal" });
      save.textContent = "Save";
      save.addEventListener(
        "click",
        guard(async () => {
          const saved = [...data.saved.filter((t) => t.name !== entry.name), { name: entry.name, template: entry.template }];
          await store.saveSettings({ "discovery.templates": saved });
          await renderTemplates();
          toast("Added to your templates");
        }),
      );

      row.append(text, use, save);
      recommendedList.append(row);
    }

    addBtn.onclick = guard(async () => {
      const name = nameInput.value.trim();
      const template = templateInput.value.trim();
      if (!name || !template) {
        toast("A template needs a name and a pattern", "error");
        return;
      }
      await store.saveSettings({
        "discovery.templates": [...data.saved.filter((t) => t.name !== name), { name, template }],
      });
      nameInput.value = templateInput.value = "";
      await renderTemplates();
      toast("Template saved");
    });
  });

  void renderTemplates();
  return group;
}

/**
 * Account controls live inside the Profile tab rather than as an eighth tab.
 * The architecture document fixes seven tabs, and "who you are" is the same
 * subject as the display name that already lives here.
 */
function buildAccountGroup(): HTMLElement {
  const group = el("div", { class: "settings-group" }, "<h4>Account</h4>");

  const col = el("div", { class: "field-col" });
  const currentLabel = el("label");
  currentLabel.textContent = "Current password";
  const currentInput = el("input", { type: "password", autocomplete: "current-password" }) as HTMLInputElement;
  const newLabel = el("label");
  newLabel.textContent = "New password (10+ characters)";
  const newInput = el("input", { type: "password", autocomplete: "new-password" }) as HTMLInputElement;
  const confirmLabel = el("label");
  confirmLabel.textContent = "Confirm new password";
  const confirmInput = el("input", { type: "password", autocomplete: "new-password" }) as HTMLInputElement;
  col.append(currentLabel, currentInput, newLabel, newInput, confirmLabel, confirmInput);

  const change = el("button", { class: "btn btn-filled" });
  change.textContent = "Change password";
  change.addEventListener(
    "click",
    guard(async () => {
      if (newInput.value !== confirmInput.value) {
        toast("The two new passwords do not match", "error");
        return;
      }
      await api.changePassword(currentInput.value, newInput.value);
      currentInput.value = newInput.value = confirmInput.value = "";
      toast("Password changed — other sessions were signed out");
    }),
  );

  const logout = el("button", { class: "btn btn-outlined", style: "margin-left:8px;" });
  logout.textContent = "Log out";
  logout.addEventListener(
    "click",
    guard(async () => {
      await api.logout();
      window.location.reload();
    }),
  );

  const hint = el("p", { class: "hint", style: "margin-top:12px;" });
  hint.textContent =
    "Changing your password signs out every other browser. If you lose it, run `python -m app.cli set-password` on the server.";

  group.append(col, change, logout, hint);
  return group;
}

/**
 * A clean-slate button for starting a fresh round of tagging and curation —
 * untags every item and clears every cover image, but keeps the images, the
 * tag/category definitions themselves, and the boards. Lives beside Account
 * rather than as its own tab: it's a one-off reset action, not an ongoing
 * setting.
 */
function buildResetGroup(): HTMLElement {
  const group = el("div", { class: "settings-group" }, "<h4>Reset</h4>");

  const hint = el("p", { class: "hint" });
  hint.textContent =
    "Untags every item and clears the avatar, banner and every board's cover. " +
    "Your images, tags/categories themselves, and boards are not touched — this clears what's applied, not what exists.";

  const reset = el("button", { class: "btn btn-error-tonal" });
  reset.textContent = "Reset tags & covers";
  reset.addEventListener(
    "click",
    guard(async () => {
      const confirmed = await confirmDialog(
        "Untag every item and clear the avatar, banner and every board's cover? " +
          "Images, tag/category definitions and boards themselves are not affected. This cannot be undone.",
        "Reset tags & covers",
      );
      if (!confirmed) return;
      await api.resetTagsAndCovers();
      await store.loadSettings();
      toast("Tags and covers reset");
    }),
  );

  group.append(hint, reset);
  return group;
}

function toggleRow(label: string, value: boolean, onChange: (value: boolean) => Promise<unknown>): HTMLElement {
  const row = el("div", { class: "field-row" });
  const text = el("span");
  text.textContent = label;
  const checkbox = el("input", { type: "checkbox" }) as HTMLInputElement;
  checkbox.checked = value;
  checkbox.addEventListener(
    "change",
    guard(async () => {
      await onChange(checkbox.checked);
      toast("Saved");
    }),
  );
  row.append(text, checkbox);
  return row;
}
