/**
 * Settings — a persistent left-hand nav (`.settings-nav`) listing every
 * settings category, with the right pane (`.settings-content`) showing
 * exactly one panel at a time. Each panel is built lazily, the first time
 * its tab is actually activated (see `ensureBuilt`) — not all eight at once
 * on mount, which is what used to make opening Settings on the Profile tab
 * also spin up the tag graph's D3 simulation and fetch the trash grid for no
 * reason. Tag graph and Trash management still live here rather than as
 * top-level nav destinations — neither is something you open as often as
 * your own collection, so neither earns a nav slot.
 */

import { api } from "../api";
import { toggleActionMenu } from "../components/actionMenu";
import { openCategoryModal } from "../components/categoryModal";
import { createColorPicker } from "../components/colorPicker";
import { Grid } from "../components/grid";
import { openGraphRuleModal } from "../components/graphRuleModal";
import { createIconPicker } from "../components/iconPicker";
import { openItemModal } from "../components/itemModal";
import { DEFAULT_GRAPH_FORCES, renderTagGraph, type TagGraphForces, type TagGraphHandle } from "../components/tagGraph";
import { createSelect } from "../components/select";
import { openSearchTemplateModal } from "../components/searchTemplateModal";
import { DECORATIVE_ICON_KEYS, icon } from "../icons";
import { ACCENT_PRESETS } from "../palette";
import * as router from "../router";
import { store } from "../store";
import type { GraphNode, Item, NearDuplicatePair, SortKey, TagCategory } from "../types";
import { appendModalCloseButton, confirmDialog, el, guard, openModal, toast, toggleSwitch } from "../ui";

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

export interface SettingsViewHandle {
  destroy: () => void;
  /** Switches the active panel without tearing down and rebuilding the
   * whole view — see the call site in main.ts for why that distinction
   * matters (it would otherwise destroy and re-fetch the tag graph and
   * trash grid on every sidebar click). */
  setTab: (tab: string) => void;
}

const PANELS: { id: router.SettingsTab; label: string; desc: string }[] = [
  { id: "profile", label: "Profile", desc: "Your display name and description." },
  { id: "security", label: "Security", desc: "Change your password or sign out of other sessions." },
  { id: "appearance", label: "Appearance", desc: "Choose a theme and an accent color." },
  { id: "collection", label: "Collection", desc: "How the collection browses, sorts and stores images." },
  { id: "discovery", label: "Discovery", desc: "The SearXNG instance and search templates Discover uses." },
  { id: "tags", label: "Tags", desc: "The tag graph, categories, graph rules and cleanup tools." },
  { id: "trash", label: "Trash", desc: "Restore or permanently delete soft-deleted items." },
  { id: "data", label: "Data management", desc: "Export, import, deduplicate, or reset the collection." },
];

export function renderSettings(root: HTMLElement, activeTab: string): SettingsViewHandle {
  const section = el("section", { class: "view active settings-view" });
  const shell = el("div", { class: "settings-shell" });
  const nav = el("nav", { class: "settings-nav" });
  const content = el("div", { class: "settings-content" });
  shell.append(nav, content);
  section.append(shell);
  root.replaceChildren(section);

  const navButtons = new Map<router.SettingsTab, HTMLButtonElement>();
  const panelEls = new Map<router.SettingsTab, HTMLElement>();
  for (const { id, label } of PANELS) {
    const button = el("button", { type: "button", class: "settings-nav-item", "data-tab": id }) as HTMLButtonElement;
    button.textContent = label;
    button.addEventListener("click", () => router.navigate({ view: "settings", tab: id }));
    nav.append(button);
    navButtons.set(id, button);

    const panel = el("div", { class: "subview settings-panel" });
    content.append(panel);
    panelEls.set(id, panel);
  }

  const loadedSettings = store.settings;
  if (!loadedSettings) {
    content.replaceChildren(el("p", { class: "hint" }, "Settings are still loading…"));
    return { destroy: () => undefined, setTab: () => undefined };
  }
  // A plain, never-reassigned `const` typed as non-null (not just narrowed
  // from one) — the panel builders below are function declarations invoked
  // later via `ensureBuilt`, and TS does not carry a closure-captured
  // variable's narrowing across a function-declaration boundary, only its
  // declared type.
  const settings = loadedSettings;

  /** Every simple form panel shares this: a heading, a one-line description,
   * and a capped-width column of fields below — Tags and Trash render full
   * width instead (a 620px cap would crush the graph and the grid) and skip
   * this helper. */
  function panelHeader(panelInfo: { label: string; desc: string }): HTMLElement {
    const form = el("div", { class: "settings-form" });
    const heading = el("h2", { class: "view-title" });
    heading.textContent = panelInfo.label;
    const desc = el("p", { class: "view-desc" });
    desc.textContent = panelInfo.desc;
    form.append(heading, desc);
    return form;
  }

  let graph: TagGraphHandle | null = null;
  let trashGrid: Grid | null = null;
  let trashIntro: HTMLElement | null = null;

  // ---------- Profile ----------
  function buildProfilePanel(panel: HTMLElement): void {
    const info = PANELS.find((p) => p.id === "profile")!;
    const form = panelHeader(info);

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
    const saveProfile = el("button", { class: "btn btn-filled btn-fixed" });
    saveProfile.textContent = "Save profile";
    saveProfile.addEventListener(
      "click",
      guard(async () => {
        await store.saveSettings({
          "profile.display_name": nameInput.value.trim(),
          "profile.description": descInput.value.trim(),
        });
        toast("Profile saved");
      }),
    );

    form.append(col, saveProfile);
    panel.append(form);
  }

  // ---------- Security ----------
  function buildSecurityPanel(panel: HTMLElement): void {
    const info = PANELS.find((p) => p.id === "security")!;
    const form = panelHeader(info);

    const pwCol = el("div", { class: "field-col" });
    const currentLabel = el("label");
    currentLabel.textContent = "Current password";
    const currentInput = el("input", { type: "password", autocomplete: "current-password" }) as HTMLInputElement;
    const newLabel = el("label");
    newLabel.textContent = "New password (10+ characters)";
    const newInput = el("input", { type: "password", autocomplete: "new-password" }) as HTMLInputElement;
    const confirmLabel = el("label");
    confirmLabel.textContent = "Confirm new password";
    const confirmInput = el("input", { type: "password", autocomplete: "new-password" }) as HTMLInputElement;
    pwCol.append(currentLabel, currentInput, newLabel, newInput, confirmLabel, confirmInput);

    const change = el("button", { class: "btn btn-filled btn-fixed" });
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
    const logout = el("button", { class: "btn btn-outlined btn-fixed", style: "margin-left:8px;" });
    logout.textContent = "Log out";
    logout.addEventListener(
      "click",
      guard(async () => {
        await api.logout();
        window.location.reload();
      }),
    );
    const pwHint = el("p", { class: "hint", style: "margin-top:12px;" });
    pwHint.textContent = "Changing your password signs out every other browser.";

    form.append(pwCol, change, logout, pwHint);
    panel.append(form);
  }

  // ---------- Appearance ----------
  function buildAppearancePanel(panel: HTMLElement): void {
    const info = PANELS.find((p) => p.id === "appearance")!;
    const form = panelHeader(info);

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

    // Accent color (design-system unification pass, originally 2026-09-17,
    // converted from an always-visible inline swatch row to a click-to-open
    // dropdown 2026-09-19 per direct request: "I want drop down menus
    // almost everywhere... the color choser" + "I mostly want the settings
    // to feel a bit more clean, minimalist and not crowded" -- still the
    // same fixed 8 presets (see /home/peter/Claude/Projects/DESIGN_SYSTEM.md:
    // sibling app Curodav offers the same 8, so picking "Teal" gets the same
    // color family in both apps), just no longer taking up a permanently
    // visible row of 8 circles in a page that already has a lot on it.
    const accentRow = el("div", { class: "field-row" });
    const accentLabel = el("span");
    accentLabel.textContent = "Accent color";
    const accentPicker = createColorPicker(
      store.settings?.["appearance.accent_color"] ?? ACCENT_PRESETS[0].hex,
      guard(async (hex) => {
        await store.saveSettings({ "appearance.accent_color": hex });
      }),
      "Accent color",
      { palette: ACCENT_PRESETS.map((preset) => ({ hex: preset.hex, name: preset.name })) },
    );
    accentRow.append(accentLabel, accentPicker.element);

    form.append(themeRow, accentRow);
    panel.append(form);
  }

  // ---------- Collection ----------
  function buildCollectionPanel(panel: HTMLElement): void {
    const info = PANELS.find((p) => p.id === "collection")!;
    const form = panelHeader(info);

    const browsing = el("div", { class: "settings-group" }, "<h4>Browsing</h4>");
    const pageRow = el("div", { class: "field-row" });
    const pageLabel = el("span");
    pageLabel.textContent = "Items per page";
    const pageInput = el("input", { type: "number", min: "1", max: "200" }) as HTMLInputElement;
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

    const sortRow = el("div", { class: "field-row" });
    const sortLabel = el("span");
    sortLabel.textContent = "Default sort";
    const commitSort = guard(async (value: string) => {
      await store.saveSettings({ "collection.default_sort": value as SortKey });
      toast("Saved");
    });
    const sortSelect = createSelect(
      [
        { value: "added_at", label: "Date added" },
        { value: "dimensions", label: "Dimensions" },
        { value: "filesize", label: "File size" },
        { value: "title", label: "Alphabetical" },
      ],
      settings["collection.default_sort"],
      commitSort,
      { ariaLabel: "Default sort" },
    );
    sortRow.append(sortLabel, sortSelect.element);
    browsing.append(pageRow, sortRow, scrollRow);

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
    const retentionInput = el("input", { type: "number", min: "0" }) as HTMLInputElement;
    retentionInput.value = String(settings["storage.trash_retention_days"]);
    retentionInput.addEventListener(
      "change",
      guard(async () => {
        await store.saveSettings({ "storage.trash_retention_days": Number(retentionInput.value) });
        toast("Saved");
      }),
    );
    retentionRow.append(retentionLabel, retentionInput);

    storage.append(convert, preserve, retentionRow);

    form.append(browsing, storage);
    panel.append(form);
  }

  // ---------- Discovery ----------
  function buildDiscoveryPanel(panel: HTMLElement): void {
    const info = PANELS.find((p) => p.id === "discovery")!;
    const form = panelHeader(info);

    // Discovery is always on — the only thing left to configure is where it
    // points and whether that address actually answers.
    const discoveryGroup = el("div", { class: "settings-group" }, "<h4>Discovery</h4>");
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

    const test = el("button", { class: "btn btn-outlined btn-fixed" });
    test.textContent = "Test connection";
    test.addEventListener(
      "click",
      guard(async () => {
        await api.discover("test");
        toast("SearXNG responded");
      }),
    );

    function updateStatus(): void {
      statusValue.innerHTML = store.discoveryEnabled
        ? '<span class="status-dot"></span>Configured — the Feed tab is visible'
        : "Not configured — the Feed tab stays hidden until a URL is set";
    }
    updateStatus();

    discoveryGroup.append(col, statusRow, test);

    form.append(discoveryGroup, buildTemplateGroup());
    panel.append(form);
  }

  // ---------- Data management ----------
  function buildDataPanel(panel: HTMLElement): void {
    const info = PANELS.find((p) => p.id === "data")!;
    const form = panelHeader(info);
    form.append(buildDataManagementGroup());
    panel.append(form);
  }

  // ---------- Tags (graph lives here) ----------
  async function buildTagsPanel(panel: HTMLElement): Promise<void> {
    const info = PANELS.find((p) => p.id === "tags")!;
    const heading = el("h2", { class: "view-title" });
    heading.textContent = info.label;
    const headingDesc = el("p", { class: "view-desc" });
    headingDesc.textContent = info.desc;
    panel.append(heading, headingDesc);

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
      const sidebarPanel = el("div", { class: "tags-sidebar-panel" });
      sidebarPanels.set(tab.id, sidebarPanel);
    }
    function activateSidebarTab(tabId: string): void {
      sidebarTabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
      sidebarPanels.forEach((sidebarPanel, id) => sidebarPanel.classList.toggle("active", id === tabId));
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
    const resetPhysicsBtn = el("button", { class: "btn btn-outlined btn-block", style: "margin-top:6px;" });
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
    const addCategoryBtn = el("button", { class: "btn btn-outlined btn-block" }, `${icon("plus", true)} Add category`);

    // ---- Graph rules: prune a redundant edge the co-occurrence graph would
    // otherwise draw, e.g. Category=Anime/Show=Haikyu/Character=Hinata on one
    // pin — the direct Anime–Hinata edge adds nothing once Hinata already
    // connects to Haikyu, so a rule removes it. Shares the "Rules & physics"
    // tab with the sliders above. Same modal treatment as categories above. ----
    const rulesHint = el("p", { class: "view-desc", style: "margin-top:0;" });
    rulesHint.textContent =
      'Hide a direct edge between two categories when a tag on one side already connects through a third. Example: don’t connect "Category" to "Character" when that character already connects via "Show".';
    const rulesList = el("div", { class: "sidebar-list" });
    const addRuleBtn = el("button", { class: "btn btn-outlined btn-block" }, `${icon("plus", true)} Add rule`);

    // Name/Category/Link/Merge-into all use the same `.field-col` pattern
    // already established for the profile Name/Description fields above
    // (label above, full-width control below) rather than `.field-row`
    // (label left, control right) -- direct feedback, 2026-09-19: "inputs
    // and selectors should be the same width". A side-by-side row can't
    // guarantee that without either overflowing this narrow sidebar (a
    // fixed width holding its ground next to a label) or letting
    // flexbox's default shrink behavior compress a short selection
    // ("Anime") more than a long one ("Character"). Stacked, both controls
    // are simply 100% of the same row width, which trivially matches
    // regardless of content or viewport. Color/icon are deliberately
    // excluded from this -- see the appearance row below.

    const editor = el("div");
    editor.hidden = true;
    const nameRow = el("div", { class: "field-col" });
    const nameLabel = el("label");
    nameLabel.textContent = "Name";
    const nameInput = el("input", { type: "text" }) as HTMLInputElement;
    nameRow.append(nameLabel, nameInput);
    const categoryRow = el("div", { class: "field-col" });
    const categoryRowLabel = el("label");
    categoryRowLabel.textContent = "Category";
    // `createSelect`'s onChange has to be supplied at construction time, but
    // the real handler below needs `selectedTag`/`graph`/`linkRow`, which
    // aren't assigned yet at this point in the function -- this indirection
    // (a mutable box, reassigned once the real handler is defined further
    // down) keeps the code in its original order instead of hoisting a big
    // block up past everything it depends on.
    let handleCategoryChange: (value: string) => void = () => {};
    const categorySelect = createSelect(
      [{ value: "", label: "— none —" }],
      "",
      (value) => handleCategoryChange(value),
      { ariaLabel: "Category" },
    );
    categoryRow.append(categoryRowLabel, categorySelect.element);
    // Only shown for tags whose category opted in — see `links_enabled` on
    // `TagCategory`. Hidden rather than removed, so toggling a tag's category
    // can show or hide it without rebuilding the row.
    const linkRow = el("div", { class: "field-col" });
    const linkRowLabel = el("label");
    linkRowLabel.textContent = "Link";
    const linkInput = el("input", { type: "url", placeholder: "https://…" }) as HTMLInputElement;
    linkRow.append(linkRowLabel, linkInput);
    linkRow.hidden = true;

    // Opts this tag out of passive browsing — the item still exists, is
    // still tagged, and still shows up in any board it belongs to or in a
    // search that names the tag directly; it just stops appearing in the
    // ambient Feed scroll.
    const hideRow = el("div", { class: "field-row" });
    const hideRowLabel = el("span");
    hideRowLabel.textContent = "Hide from Feed";
    const hideSwitch = toggleSwitch(false, undefined, "Hide from Feed");
    const hideInput = hideSwitch.input;
    hideRow.append(hideRowLabel, hideSwitch.element);
    const hideHint = el("p", { class: "hint", style: "margin-top:-4px;" });
    hideHint.textContent = "Still shows up in boards and in a search that names it directly.";

    // Merge: distinct from rename above — rename changes what this tag is
    // called, merge collapses this tag and a different one into a single
    // identity (see advance.md §10, "landscape" / "landscapes"). A plain
    // <select> of every other tag is enough here; this is a maintenance
    // action reached rarely enough that a dedicated picker modal would be
    // more ceremony than the task warrants.
    const mergeRow = el("div", { class: "field-col", style: "margin-top:10px;" });
    const mergeRowLabel = el("label");
    mergeRowLabel.textContent = "Merge into";
    const mergeSelect = createSelect([], "", undefined, { ariaLabel: "Merge into" });
    mergeRow.append(mergeRowLabel, mergeSelect.element);
    const mergeBtn = el("button", {
      class: "btn btn-outlined btn-block",
      style: "margin-top:6px;",
    }, `${icon("merge", true)} Merge tag`);

    // Color + icon last, grouped together -- direct feedback, 2026-09-19:
    // "color and icons should always be at the end of the list" (appearance
    // choices, lowest priority relative to identity/classification/behavior
    // fields above) and "both should have the same design" (matching
    // rounded-square triggers, not a circle next to a square -- see
    // `.color-swatch-trigger`'s CSS).
    const appearanceRow = el("div", { class: "field-grid", style: "margin-top:14px;" });
    const colorCol = el("div");
    const colorLabel = el("span", { class: "hint", style: "display:block; margin-bottom:6px;" });
    colorLabel.textContent = "Color";
    // Same construction-order indirection as `handleCategoryChange` above --
    // the real handler needs `selectedTag`/`graph`, not yet assigned here.
    let handleColorChange: (hex: string) => void = () => {};
    const colorPicker = createColorPicker("#457b9d", (hex) => handleColorChange(hex), "Color");
    colorCol.append(colorLabel, colorPicker.element);
    const iconCol = el("div");
    const iconColLabel = el("span", { class: "hint", style: "display:block; margin-bottom:6px;" });
    iconColLabel.textContent = "Icon";
    // A tag's own icon; unset, it falls back to its category's (the category
    // modal sets that default) — same precedence as color.
    const tagIconPicker = createIconPicker(
      DECORATIVE_ICON_KEYS,
      null,
      guard(async (key) => {
        if (!selectedTag) return;
        // Not reflected on the graph node itself — its circle is already
        // carrying color and name; the icon shows up on the tag's chips
        // elsewhere (item modal, board pickers) instead.
        const updated = await api.patchTag(selectedTag.id, { icon: key });
        selectedTag.icon = updated.icon;
        await store.loadTags();
        toast(key ? "Tag icon updated" : "Tag icon cleared");
      }),
      { allowNone: true, ariaLabel: "Icon" },
    );
    iconCol.append(iconColLabel, tagIconPicker.element);
    appearanceRow.append(colorCol, iconCol);

    const viewImages = el("button", {
      class: "btn btn-tonal btn-block",
      style: "margin-top:14px;",
    }, `${icon("search", true)} View images`);
    const deleteTagBtn = el("button", {
      class: "btn btn-error-tonal btn-block",
      style: "margin-top:10px;",
    }, `${icon("trash", true)} Delete tag`);
    editor.append(
      // Identity, classification, behavior — the descriptive fields.
      nameRow,
      categoryRow,
      linkRow,
      hideRow,
      hideHint,
      // Appearance (color + icon) is the true last field, per the
      // "color and icons should always be at the end of the list" rule.
      appearanceRow,
      // Actions below this point, not fields — merge-into stays paired
      // with its own Merge button rather than separated by appearanceRow,
      // the same "pick a target, act on it immediately below" pattern as
      // View images/Delete tag.
      mergeRow,
      mergeBtn,
      viewImages,
      deleteTagBtn,
    );

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
    const refreshUnusedBtn = el("button", { class: "btn btn-outlined btn-block" }, `${icon("refresh", true)} Refresh`);

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
    const scanDupesBtn = el(
      "button",
      { class: "btn btn-outlined btn-block" },
      `${icon("scan", true)} Scan for near-duplicates`,
    );
    scanDupesBtn.addEventListener("click", guard(() => renderNearDuplicatesInto(dupeList)));

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
    panel.append(layout);

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
        dot.style.background = category.color;
        name.append(dot);
        // The default icon every tag under this category shows unless it has
        // one of its own — see ui.ts's `tagIconKey`.
        if (category.icon) name.insertAdjacentHTML("beforeend", icon(category.icon, true));
        name.append(document.createTextNode(category.name));
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
      categorySelect.setOptions(
        [
          { value: "", label: "— none —" },
          ...categories.map((category) => ({ value: String(category.id), label: category.name })),
        ],
        currentId ? String(currentId) : "",
      );
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
      colorPicker.setValue(node.color ?? "#457b9d");
      refreshCategorySelect(node.category?.id ?? null);
      linkRow.hidden = !node.category?.links_enabled;
      linkInput.value = node.link_url ?? "";
      hideInput.checked = node.hide_from_feed ?? false;
      tagIconPicker.set(node.icon ?? null);

      const mergeTargets = store.tags.filter((other) => other.id !== node.id);
      mergeSelect.setOptions(
        mergeTargets.map((other) => ({ value: String(other.id), label: other.name })),
        mergeTargets[0] ? String(mergeTargets[0].id) : "",
      );
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
    handleColorChange = guard(async (hex: string) => {
      if (!selectedTag) return;
      const updated = await api.patchTag(selectedTag.id, { color: hex });
      graph?.updateNode(selectedTag.id, { color: updated.color ?? undefined });
      selectedTag.color = updated.color;
      await store.loadTags();
      toast("Tag color updated");
    });
    handleCategoryChange = guard(async (value: string) => {
      if (!selectedTag) return;
      const updated = await api.patchTag(
        selectedTag.id,
        value ? { category_id: Number(value) } : { clear_category: true },
      );
      graph?.updateNode(selectedTag.id, { color: updated.color, category: updated.category });
      selectedTag.category = updated.category;
      linkRow.hidden = !updated.category?.links_enabled;
      await store.loadTags();
      toast("Category updated");
    });
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
    hideInput.addEventListener(
      "change",
      guard(async () => {
        if (!selectedTag) return;
        const updated = await api.patchTag(selectedTag.id, { hide_from_feed: hideInput.checked });
        selectedTag.hide_from_feed = updated.hide_from_feed;
        toast(hideInput.checked ? "Hidden from the Feed" : "Visible in the Feed again");
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
        const targetId = Number(mergeSelect.getValue());
        if (!targetId) {
          toast("Add another tag first — there's nothing to merge into yet");
          return;
        }
        const targetName = mergeSelect.getLabel() || "that tag";
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
  async function buildTrashPanel(panel: HTMLElement): Promise<void> {
    const info = PANELS.find((p) => p.id === "trash")!;
    const heading = el("h2", { class: "view-title" });
    heading.textContent = info.label;

    const retention = store.settings?.["storage.trash_retention_days"] ?? 30;
    trashIntro = el("p", { class: "view-desc" });
    trashIntro.textContent = `Soft-deleted items. Retained ${retention} days before permanent purge.`;

    const purgeRow = el("div", { style: "display:flex; gap:10px; margin-bottom:16px;" });
    const purgeExpired = el("button", { class: "btn btn-outlined btn-fixed" });
    purgeExpired.textContent = "Purge expired now";
    const purgeAll = el("button", { class: "btn btn-error-tonal btn-fixed" });
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

    panel.append(heading, trashIntro, purgeRow, trashGrid.element);
    await trashGrid.reload();
    // Cards in the trash are dimmed until hovered, which is what distinguishes
    // the trash grid from the collection at a glance.
    trashGrid.gridElement.querySelectorAll(".card").forEach((card) => card.classList.add("trash-card"));
  }

  // ---------- lazy mount + tab switching ----------
  const built = new Set<router.SettingsTab>();

  async function ensureBuilt(tab: router.SettingsTab): Promise<void> {
    if (tab === "trash") {
      if (built.has("trash")) {
        const retention = store.settings?.["storage.trash_retention_days"] ?? 30;
        if (trashIntro) trashIntro.textContent = `Soft-deleted items. Retained ${retention} days before permanent purge.`;
        await trashGrid?.reload();
        return;
      }
      built.add("trash");
      await buildTrashPanel(panelEls.get("trash")!);
      return;
    }
    if (built.has(tab)) return;
    built.add(tab);
    switch (tab) {
      case "profile":
        buildProfilePanel(panelEls.get("profile")!);
        break;
      case "security":
        buildSecurityPanel(panelEls.get("security")!);
        break;
      case "appearance":
        buildAppearancePanel(panelEls.get("appearance")!);
        break;
      case "collection":
        buildCollectionPanel(panelEls.get("collection")!);
        break;
      case "discovery":
        buildDiscoveryPanel(panelEls.get("discovery")!);
        break;
      case "data":
        buildDataPanel(panelEls.get("data")!);
        break;
      case "tags":
        await buildTagsPanel(panelEls.get("tags")!);
        break;
    }
  }

  function setTab(tab: string): void {
    const resolved = (router.SETTINGS_TABS as readonly string[]).includes(tab)
      ? (tab as router.SettingsTab)
      : "profile";
    for (const { id } of PANELS) {
      navButtons.get(id)!.classList.toggle("active", id === resolved);
      panelEls.get(id)!.classList.toggle("active", id === resolved);
    }
    // Tags and Trash render their own full-width graph/grid and want the
    // shell's usual 900px cap lifted; every other (form-style) panel keeps it
    // so it doesn't float in a wide stretch of empty background.
    shell.classList.toggle("settings-shell--wide", resolved === "tags" || resolved === "trash");
    void ensureBuilt(resolved);
  }

  setTab(activeTab);

  return {
    destroy: () => {
      graph?.destroy();
      trashGrid?.destroy();
    },
    setTab,
  };
}

/**
 * Search templates for Discovery.
 *
 * The Feed's search box should take the subject and nothing else — "Shōyō
 * Hinata", not "Shōyō Hinata artwork high resolution -pinterest". The template
 * holds that boilerplate once, `{query}` marks where the subject goes, and the
 * backend expands it.
 */
function buildTemplateGroup(): HTMLElement {
  const group = el("div", { class: "settings-group" }, "<h4>Search template</h4>");

  const intro = el("p", { class: "hint" });
  intro.textContent =
    "Applied to everything you search in the Feed. Use {query} where your search terms should go — " +
    'for example "{query} artwork", "{query} high resolution" or "{query} -pinterest".';

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

  const addBtn = el("button", { class: "btn btn-outlined btn-block", style: "margin-top:10px;" }, `${icon("plus", true)} Add template`);

  group.append(intro, activeInput, preview, savedLabel, savedList, addBtn);

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

      const use = el("button", { class: "btn btn-outlined btn-fixed" });
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

      const remove = el("button", { class: "btn btn-error-tonal btn-fixed" });
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

    addBtn.onclick = () => {
      openSearchTemplateModal(async (name, template) => {
        await store.saveSettings({
          "discovery.templates": [...data.saved.filter((t) => t.name !== name), { name, template }],
        });
        await renderTemplates();
        toast("Template saved");
      });
    };
  });

  void renderTemplates();
  return group;
}

/**
 * Groups near-duplicate pairs into clusters of mutually-similar items.
 *
 * The backend reports *pairs* (a scan is O(n²) over items, not over clusters),
 * so four copies of the same picture show up as six overlapping pairs sharing
 * ids. Resolving pair-by-pair would ask "keep A or B?" and then separately
 * "keep A or C?" for the same picture — union-find collapses every pair that
 * shares an id into one group, so the review is "here are all 4, pick one"
 * exactly once.
 */
function groupNearDuplicates(pairs: NearDuplicatePair[]): Item[][] {
  const parent = new Map<number, number>();
  const itemsById = new Map<number, Item>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression, so repeated lookups in the same group don't walk the
    // whole chain again.
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  for (const pair of pairs) {
    for (const item of [pair.a, pair.b]) {
      if (!parent.has(item.id)) {
        parent.set(item.id, item.id);
        itemsById.set(item.id, item);
      }
    }
    const rootA = find(pair.a.id);
    const rootB = find(pair.b.id);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  const groups = new Map<number, Item[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const list = groups.get(root);
    if (list) list.push(itemsById.get(id)!);
    else groups.set(root, [itemsById.get(id)!]);
  }
  return [...groups.values()];
}

/** Higher resolution wins; equal resolution falls back to the larger file,
 * which for the same picture usually means less lossy compression. Only ever
 * used to pick a *default* — the person reviewing can still click a different
 * copy before confirming. */
function highestQuality(items: Item[]): Item {
  return [...items].sort((a, b) => b.width * b.height - a.width * a.height || b.filesize - a.filesize)[0];
}

/**
 * Scans for near-duplicates, groups them, and renders one row per group into
 * `container`: every copy found, one of them picked to keep (the
 * highest-quality copy by default, overridable by clicking another), and a
 * single action that trashes the rest. Shared by the Tags → Cleanup panel and
 * the Data Management "Check & merge duplicates" action below, so the two
 * entry points don't carry two copies of the same scan-and-resolve logic.
 */
async function renderNearDuplicatesInto(container: HTMLElement, toolbarSlot?: HTMLElement): Promise<void> {
  container.replaceChildren(el("span", { class: "hint" }, "Scanning…"));
  const pairs = await api.nearDuplicates();
  container.replaceChildren();
  if (!pairs.length) {
    container.append(el("span", { class: "hint" }, "No near-duplicates found."));
    return;
  }

  // Groups with the most copies to sort out are the most worth seeing first.
  const groups = groupNearDuplicates(pairs).sort((a, b) => b.length - a.length);

  // Reviewing dozens of groups one "Keep selected, trash the rest" click at a
  // time doesn't scale — most of the time the highest-quality copy already
  // picked as the default is the right call for every group. This collects
  // one resolver per group (respecting whatever the person has manually
  // selected so far) so a single button can run all of them, while the
  // per-group buttons still work individually for anyone who wants to check
  // each group first.
  //
  // `toolbarSlot`, when given (the duplicates modal's footer), is already
  // pinned outside the scrolling list, so the button goes straight in there.
  // Without it (the Tags → Cleanup panel, which has no separate footer) the
  // button gets its own sticky wrapper at the top of `container` instead.
  const resolvers: Array<() => Promise<number>> = [];
  const extraCount = groups.reduce((sum, group) => sum + group.length - 1, 0);
  const resolveAllBtn = el(
    "button",
    { class: "btn btn-tonal btn-fixed" },
    `${icon("trash", true)} Trash all extras (${extraCount})`,
  );
  resolveAllBtn.addEventListener(
    "click",
    guard(async () => {
      const pending = [...resolvers];
      resolvers.length = 0;
      resolveAllBtn.remove();
      const counts = await Promise.all(pending.map((resolve) => resolve()));
      const total = counts.reduce((sum, n) => sum + n, 0);
      toast(total === 1 ? "Moved 1 duplicate to trash" : `Moved ${total} duplicates to trash`);
    }),
  );
  // What to tear down once every group has been resolved and the button is
  // no longer meaningful — just the button itself when it lives directly in
  // the modal's footer, or the whole sticky wrapper when one was created for
  // it below.
  let removeToolbar: () => void;
  if (toolbarSlot) {
    resolveAllBtn.style.marginRight = "auto";
    toolbarSlot.prepend(resolveAllBtn);
    removeToolbar = () => resolveAllBtn.remove();
  } else {
    const toolbar = el("div", { class: "duplicates-toolbar row-actions" });
    toolbar.append(resolveAllBtn);
    container.append(toolbar);
    removeToolbar = () => toolbar.remove();
  }

  for (const group of groups) {
    const best = highestQuality(group);
    let keptId = best.id;

    const row = el("div", { class: "dupe-group" });
    const count = el("p", { class: "hint", style: "margin:0 0 8px;" });
    count.textContent =
      group.length === 2
        ? "2 copies of the same picture — pick one to keep, the other goes to trash."
        : `${group.length} copies of the same picture — pick one to keep, the rest go to trash.`;
    const thumbs = el("div", { class: "dupe-group-thumbs" });

    const thumbEls = new Map<number, HTMLElement>();
    function paintSelection(): void {
      for (const [id, thumbEl] of thumbEls) thumbEl.classList.toggle("selected", id === keptId);
    }

    for (const item of group) {
      const thumb = el("div", {
        class: "dupe-group-thumb",
        role: "radio",
        tabindex: "0",
        "aria-label": `Keep ${item.title ?? "this copy"}`,
      });
      const img = el("img", { src: item.urls.thumb, loading: "lazy", alt: item.title ?? "" });
      const meta = el("div", { class: "dupe-group-meta" });
      meta.textContent = `${item.width}×${item.height}`;
      const preview = el(
        "button",
        { type: "button", class: "dupe-group-preview", title: "Open full size", "aria-label": "Open full size" },
        icon("search", true),
      );
      preview.addEventListener("click", (event) => {
        event.stopPropagation();
        openItemModal(item, { siblings: group });
      });
      thumb.append(img, preview, meta);
      if (item.id === best.id) thumb.append(el("span", { class: "quality-badge" }, "Highest quality"));

      const select = () => {
        keptId = item.id;
        paintSelection();
      };
      thumb.addEventListener("click", select);
      thumb.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      });
      thumbEls.set(item.id, thumb);
      thumbs.append(thumb);
    }
    paintSelection();

    // Shared by the row's own button and the "Trash all extras" bulk action —
    // both just need "trash whatever isn't currently selected for this group,
    // then remove the row and say how many went to trash."
    const resolveGroup = async (): Promise<number> => {
      const toTrash = group.filter((item) => item.id !== keptId);
      await Promise.all(toTrash.map((item) => api.deleteItem(item.id)));
      const index = resolvers.indexOf(resolveGroup);
      if (index !== -1) resolvers.splice(index, 1);
      row.remove();
      if (!resolvers.length) removeToolbar();
      return toTrash.length;
    };
    resolvers.push(resolveGroup);

    const actions = el("div", { class: "row-actions", style: "margin-top:10px;" });
    const resolve = el("button", { class: "btn btn-tonal btn-fixed" }, "Keep selected, trash the rest");
    resolve.addEventListener(
      "click",
      guard(async () => {
        const trashedCount = await resolveGroup();
        toast(trashedCount === 1 ? "Moved 1 duplicate to trash" : `Moved ${trashedCount} duplicates to trash`);
      }),
    );
    actions.append(resolve);
    row.append(count, thumbs, actions);
    container.append(row);
  }
}

function openDuplicatesModal(): void {
  const modal = openModal({ maxWidth: "640px", className: "duplicates-modal-body", customHeader: true });

  const heading = el("h3");
  heading.textContent = "Check & merge duplicates";
  const subhead = el("p", { class: "hint" });
  subhead.textContent = "Pick which copy to keep for each match below — the rest move to trash.";
  modal.header?.append(heading, subhead);

  const list = el("div", { class: "sidebar-list" });
  modal.body.append(list);

  appendModalCloseButton(modal, "Close");

  void renderNearDuplicatesInto(list, modal.footer);
}

/**
 * Import/export, a scan for near-duplicates, and the two destructive resets —
 * one that clears what's applied (tags, covers) and one that clears what
 * exists (the whole collection). Grouped together because all five are
 * maintenance actions reached rarely, not everyday settings.
 */
/**
 * One status card in the top row -- icon + title + a "..." menu holding that
 * card's one action, a muted status line, and a description. Same shape as
 * sibling app Curodav's own Database/Backup/Sync cards (direct feedback,
 * 2026-09-19: "make this page more similar to [Curodav's Data & Maintenance
 * cards]"), though nothing here fabricates a Curodav-only concept (backup
 * history, sync devices) Pineart has no data for -- each status line reflects
 * only what's actually true right now (idle/ready, not a fake "healthy").
 */
function statusCard(
  iconName: string,
  title: string,
  status: string,
  desc: string,
  menuLabel: string,
  menuIcon: string,
  onAction: () => void,
): HTMLElement {
  const card = el("div", { class: "status-card" });
  const header = el("div", { class: "status-card-header" });
  header.append(el("span", { class: "status-card-title" }, `${icon(iconName, true)} ${title}`));
  const menuBtn = el("button", { class: "icon-btn", "aria-label": `${title} actions` }, icon("kebab", true));
  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleActionMenu({
      trigger: menuBtn,
      ariaLabel: `${title} actions`,
      sections: [{ items: [{ action: "run", label: menuLabel, icon: menuIcon }] }],
      onAction,
    });
  });
  header.append(menuBtn);
  const statusLine = el("p", { class: "status-card-status" }, `<span class="status-dot muted"></span>${status}`);
  const descLine = el("p", { class: "status-card-desc" });
  descLine.textContent = desc;
  card.append(header, statusLine, descLine);
  return card;
}

/**
 * A row inside the danger-zone card below the status grid -- title + description
 * on the left, the one destructive action on the right, matching Curodav's own
 * "Restart app" / "Auto-archive..." row shape (label+desc left, control right,
 * divider between rows) rather than this panel's old flat `.field-row` list.
 */
function dangerRow(title: string, desc: string, buttonLabel: string, onClick: () => void): HTMLElement {
  const row = el("div", { class: "settings-card-row" });
  const text = el("div");
  const strong = el("strong");
  strong.textContent = title;
  const descEl = el("p", { class: "hint" });
  descEl.textContent = desc;
  text.append(strong, descEl);
  const button = el("button", { class: "btn btn-error-tonal btn-fixed" });
  button.textContent = buttonLabel;
  button.addEventListener("click", onClick);
  row.append(text, button);
  return row;
}

function buildDataManagementGroup(): HTMLElement {
  const group = el("div", { class: "settings-group" }, "<h4>Data Management</h4>");

  const importInput = el("input", { type: "file", accept: ".zip" }) as HTMLInputElement;
  importInput.hidden = true;
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

  const cardGrid = el("div", { class: "status-card-grid" });
  cardGrid.append(
    statusCard(
      "download",
      "Export",
      "Ready",
      "Full backup of your database and image files.",
      "Download export",
      "download",
      () => {
        const link = el("a", { href: api.exportUrl, download: "" }) as HTMLAnchorElement;
        link.click();
      },
    ),
    statusCard(
      "upload",
      "Import",
      "No import yet",
      "Import is keyed on image content — re-importing an archive you already have is a no-op.",
      "Choose archive…",
      "upload",
      () => importInput.click(),
    ),
    statusCard(
      "scan",
      "Duplicates",
      "Not scanned yet",
      "Scan the collection for near-duplicate images.",
      "Check & merge duplicates",
      "scan",
      openDuplicatesModal,
    ),
  );

  const dangerCard = el("div", { class: "settings-card" });
  dangerCard.append(
    dangerRow(
      "Reset",
      "Untag every item and clear the avatar, banner and every board's cover. Images, tag/category definitions and boards themselves are not affected. This cannot be undone.",
      "Reset",
      guard(async () => {
        const confirmed = await confirmDialog(
          "Untag every item and clear the avatar, banner and every board's cover? " +
            "Images, tag/category definitions and boards themselves are not affected. This cannot be undone.",
          "Reset",
        );
        if (!confirmed) return;
        await api.resetTagsAndCovers();
        await store.loadSettings();
        toast("Tags and covers reset");
      }),
    ),
    dangerRow(
      "Delete all",
      "Delete every image, board, tag and category — the entire collection. This cannot be undone.",
      "Delete all",
      guard(async () => {
        const confirmed = await confirmDialog(
          "Delete the entire collection? Every image file, board, tag and category is permanently removed. " +
            "This cannot be undone.",
          "Delete all",
        );
        if (!confirmed) return;
        await api.deleteAllData();
        await Promise.all([store.loadSettings(), store.loadTags(), store.loadGraph().catch(() => undefined)]);
        toast("Collection deleted");
      }),
    ),
  );

  group.append(cardGrid, dangerCard, importInput);
  return group;
}

function toggleRow(label: string, value: boolean, onChange: (value: boolean) => Promise<unknown>): HTMLElement {
  const row = el("div", { class: "field-row" });
  const text = el("span");
  text.textContent = label;
  const commit = guard(async (checked: boolean) => {
    await onChange(checked);
    toast("Saved");
  });
  row.append(text, toggleSwitch(value, commit, label).element);
  return row;
}
