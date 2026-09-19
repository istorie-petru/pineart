/**
 * Search bar with the filter dropdown — architecture §6.2.
 *
 * The central idea: the search bar *is* the filter state. Selecting a tag, a
 * colour swatch or an orientation writes a `tag:`/`color:`/`orientation:` token
 * into the input rather than into a parallel hidden state object. That means
 * what the user sees and what the backend receives are the same string, the
 * filter is copy-pasteable and shareable, and there is no way for the visible
 * chips and the actual query to disagree — a class of bug that a separate
 * filter-state object invites.
 */

import { api } from "../api";
import { icon } from "../icons";
import { createSelect, type CustomSelect } from "./select";
import { store } from "../store";
import type { SortKey, TagSuggestion } from "../types";
import { el } from "../ui";

/**
 * Swatches write their *name* into the search bar (`color:red`), not their hex.
 * The bar is meant to be read and typed by a person, and `color:#e63946` is
 * neither; the backend resolves the same names to these exact values, and still
 * accepts raw hex for anything not in this list.
 */
const SWATCHES = [
  { name: "red", hex: "#e63946" },
  { name: "orange", hex: "#f4a261" },
  { name: "gold", hex: "#e9c46a" },
  { name: "green", hex: "#588157" },
  { name: "teal", hex: "#2a9d8f" },
  { name: "blue", hex: "#457b9d" },
  { name: "purple", hex: "#6d597a" },
  { name: "black", hex: "#2b2b2b" },
];

const ORIENTATIONS = ["portrait", "landscape", "square"] as const;

/**
 * Matches any filter token, used to strip them out and leave the free text.
 * A token can be negated two ways — a leading "-" or a "!" right after the
 * colon (`-tag:portrait` / `tag:!portrait`, see search.py's `TOKEN_RE` for
 * why both exist) — both have to be included here, or stripping a negated
 * token out to compute the free-text remainder leaves its "-"/"!" behind as
 * orphaned text.
 */
const TOKEN_PATTERN = /-?(tag|color|orientation):!?("[^"]+"|\S+)/gi;

const SORT_LABELS: Record<SortKey, string> = {
  random: "Random",
  added_at: "Date added",
  dimensions: "Dimensions",
  filesize: "File size",
  title: "Alphabetical",
};

export interface SearchBarOptions {
  onChange: (query: string, sort: SortKey) => void;
  initialSort?: SortKey;
  /**
   * Pre-fills the bar without calling `onChange` — the caller is expected to
   * already know this value and use it for its own first fetch. `setValue()`
   * fires `onChange` synchronously, so using it here as well as the caller's
   * own initial load would fire two overlapping fetches for the same first
   * page; the in-flight guard on the second one then discards *both*, since
   * the first is marked stale before its response ever lands. That was the
   * bug behind "View images" from a tag opening to an empty grid.
   */
  initialValue?: string;
}

export class SearchBar {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly dropdown: HTMLElement;
  private readonly tagList: HTMLElement;
  private readonly tagFilter: HTMLInputElement;
  private readonly swatchRow!: HTMLElement;
  private readonly orientRow!: HTMLElement;
  /** Guards against an older suggestion response overwriting a newer one. */
  private suggestRequest = 0;
  private sort: SortKey;
  private readonly sortSelect: CustomSelect;

  constructor(private readonly options: SearchBarOptions) {
    this.sort = options.initialSort ?? "added_at";

    this.input = el("input", {
      type: "search",
      placeholder: "Search your collection… try tag:landscape",
    }) as HTMLInputElement;
    if (options.initialValue) this.input.value = options.initialValue;

    const inputWrap = el("div", { class: "search-input-wrap" }, icon("search", true));
    inputWrap.append(this.input);

    const sortSelect = createSelect(
      Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label })),
      this.sort,
      (value) => {
        this.sort = value as SortKey;
        this.emit();
      },
      { ariaLabel: "Sort" },
    );
    this.sortSelect = sortSelect;

    const row = el("div", { class: "search-row" });
    row.append(inputWrap, sortSelect.element);

    this.tagFilter = el("input", {
      type: "text",
      class: "dropdown-search",
      placeholder: "Filter tags…",
    }) as HTMLInputElement;
    this.tagList = el("div", { class: "dropdown-tags" });

    const swatchRow = el("div", { class: "swatch-row" });
    for (const swatch of SWATCHES) {
      const dot = el("span", { class: "swatch", title: swatch.name });
      dot.dataset.color = swatch.name;
      dot.style.background = swatch.hex;
      dot.addEventListener("click", () => this.toggleToken("color", swatch.name));
      swatchRow.append(dot);
    }
    this.swatchRow = swatchRow;

    const orientRow = el("div", { class: "chip-row" });
    for (const orientation of ORIENTATIONS) {
      const chip = el("span", { class: "chip" });
      chip.dataset.orientation = orientation;
      chip.textContent = orientation[0].toUpperCase() + orientation.slice(1);
      chip.addEventListener("click", () => this.toggleToken("orientation", orientation));
      orientRow.append(chip);
    }
    this.orientRow = orientRow;

    this.dropdown = el("div", { class: "filter-dropdown" });
    const colorSection = el("div", { class: "dropdown-section" }, '<span class="fg-label">Color</span>');
    colorSection.append(swatchRow);
    const orientSection = el(
      "div",
      { class: "dropdown-section", style: "margin-bottom:0;" },
      '<span class="fg-label">Orientation</span>',
    );
    orientSection.append(orientRow);
    this.dropdown.append(
      this.tagFilter,
      this.tagList,
      el("div", { class: "dropdown-divider" }),
      colorSection,
      orientSection,
    );

    const container = el("div", { class: "search-filter-container" });
    container.append(row, this.dropdown);

    this.element = el("div", { class: "filterbar" });
    this.element.append(container);

    // Filters stay out of the way until the search bar is focused, so a fresh
    // install shows a grid rather than a wall of controls.
    this.input.addEventListener("focus", () => {
      this.dropdown.classList.add("open");
      this.renderTags();
    });
    document.addEventListener("click", (event) => {
      if (!container.contains(event.target as Node)) this.dropdown.classList.remove("open");
    });
    this.tagFilter.addEventListener("input", () => this.renderTags());

    let debounceTimer: number | undefined;
    this.input.addEventListener("input", () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => this.emit(), 250);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        window.clearTimeout(debounceTimer);
        this.emit();
      }
    });

    // Syncs the swatch/orientation chips against `initialValue` without
    // touching `onChange` — see the option's doc comment.
    this.syncChipStates();
  }

  get value(): string {
    return this.input.value;
  }

  setValue(query: string): void {
    this.input.value = query;
    this.emit();
  }

  /** Programmatic sort change (e.g. "Surprise me" forcing Random) — updates
   * the dropdown to match but, like `initialValue`, does not itself fire
   * `onChange`; the caller decides when to reload. */
  setSort(sort: SortKey): void {
    this.sort = sort;
    this.sortSelect.setValue(sort);
  }

  private emit(): void {
    this.options.onChange(this.input.value.trim(), this.sort);
    this.syncChipStates();
  }

  /** True only for a *positive* match — a negated token (excluding this
   * value) is not "this value is selected", which is what every current
   * caller (chip/swatch highlighting) means by "active". */
  private hasToken(key: string, value: string): boolean {
    return this.tokens(key).some((t) => !t.negated && t.value === value.toLowerCase());
  }

  private tokens(key: string): { value: string; negated: boolean }[] {
    const matches = this.input.value.matchAll(new RegExp(`(-)?${key}:(!)?("[^"]+"|\\S+)`, "gi"));
    return Array.from(matches, (m) => ({
      value: m[3].replace(/"/g, "").toLowerCase(),
      negated: Boolean(m[1] || m[2]),
    }));
  }

  /**
   * Toggle a token and rewrite the bar canonically: tokens first, free text
   * last, no duplicates.
   *
   * Appending and string-replacing in place (the obvious approach) drifts —
   * `tag:a foo tag:b` and `foo tag:a tag:b` are the same filter but look
   * different, and removing a token by substring can eat part of another one.
   * Rebuilding from the parsed state means the bar always reads the same way for
   * the same filter.
   */
  private toggleToken(key: string, value: string): void {
    const state = {
      tag: this.tokens("tag"),
      color: this.tokens("color"),
      orientation: this.tokens("orientation"),
    };
    const list = state[key as keyof typeof state];
    const needle = value.toLowerCase();
    // Only a *positive* match toggles off here — these chips/swatches only
    // ever add the positive form, so clicking one while `tag:!x` sits in the
    // bar (typed by hand) should not touch that exclusion at all. Without
    // this, rebuilding the bar below from `state` — which is exactly what a
    // manually-typed `-tag:`/`tag:!` token round-trips through — would have
    // silently dropped that exclusion the moment any chip was clicked, since
    // this function never re-adds a token it didn't know to preserve.
    const index = list.findIndex((t) => !t.negated && t.value === needle);
    if (index >= 0) list.splice(index, 1);
    else list.push({ value: needle, negated: false });

    const freeText = this.input.value.replace(TOKEN_PATTERN, " ").split(/\s+/).filter(Boolean).join(" ");
    const format = (tokenKey: string, t: { value: string; negated: boolean }) => {
      const prefix = t.negated ? "-" : "";
      const val = t.value.includes(" ") ? `"${t.value}"` : t.value;
      return `${prefix}${tokenKey}:${val}`;
    };
    const tokens = [
      ...state.tag.map((t) => format("tag", t)),
      ...state.color.map((t) => format("color", t)),
      ...state.orientation.map((t) => format("orientation", t)),
    ];
    this.input.value = [...tokens, freeText].filter(Boolean).join(" ");
    this.emit();
  }

  /** Keeps every chip and swatch in step with whatever the bar currently says. */
  private syncChipStates(): void {
    this.tagList.querySelectorAll<HTMLElement>(".chip[data-tag]").forEach((chip) => {
      chip.classList.toggle("active", this.hasToken("tag", chip.dataset.tag ?? ""));
    });
    this.swatchRow?.querySelectorAll<HTMLElement>(".swatch").forEach((dot) => {
      dot.classList.toggle("active", this.hasToken("color", dot.dataset.color ?? ""));
    });
    this.orientRow?.querySelectorAll<HTMLElement>(".chip").forEach((chip) => {
      chip.classList.toggle("active", this.hasToken("orientation", chip.dataset.orientation ?? ""));
    });
  }

  /**
   * Filtering goes through the suggestion endpoint rather than a substring test
   * over the cached list, so the dropdown tolerates typos, accents and word
   * order exactly like every other tag field — "hinata" and "shoyo" both surface
   * "Shōyō Hinata", and neither would have matched a naive `includes`.
   */
  private renderTags(): void {
    const needle = this.tagFilter.value.trim();
    const requestId = ++this.suggestRequest;
    void api
      .suggestTags(needle, 60)
      .then((matching) => {
        if (requestId !== this.suggestRequest) return;
        this.paintTags(matching);
      })
      .catch(() => this.paintTags(store.tags.map((tag) => ({ ...tag, usage_count: 0 }))));
  }

  /**
   * Graph rules gate one category behind another — e.g. a rule with
   * to=Character, via=Show means Character tags have nothing to do with the
   * search until a Show tag is already part of the query, and even then only
   * the Characters actually connected to *that* Show are worth offering, not
   * every Character in the collection. Same rule the tag graph visualization
   * uses to suppress a redundant edge; here it suppresses a premature
   * suggestion instead.
   */
  private applyGraphGating(matching: TagSuggestion[]): TagSuggestion[] {
    if (!store.graphRules.length) return matching;

    // An excluded tag (`-tag:x` / `tag:!x`) hasn't been "picked" in the sense
    // a gating rule cares about — it's the opposite, so it must not open a
    // gate the way actually selecting the via-tag would.
    const selectedTags = this.tokens("tag")
      .filter((t) => !t.negated)
      .map((t) => store.tags.find((tag) => tag.slug === t.value))
      .filter((t): t is (typeof store.tags)[number] => Boolean(t));

    return matching.filter((tag) => {
      const categoryId = tag.category?.id;
      if (categoryId == null) return true;
      const gatingRules = store.graphRules.filter((rule) => rule.to_category.id === categoryId);
      if (!gatingRules.length) return true; // this category isn't gated by anything

      const activeRule = gatingRules.find((rule) =>
        selectedTags.some((selected) => selected.category?.id === rule.via_category.id),
      );
      if (!activeRule) return false; // gated, and the gate isn't open yet

      const viaTagIds = selectedTags
        .filter((selected) => selected.category?.id === activeRule.via_category.id)
        .map((selected) => selected.id);
      return viaTagIds.some((viaId) => store.isConnected(viaId, tag.id));
    });
  }

  /**
   * Grouped by supercategory (Character, Show, Media type, …) rather than one
   * flat list, so a collection with a few hundred tags stays scannable. Tags
   * with no category fall into "Uncategorized", kept last so it reads as the
   * leftover bucket rather than competing with named categories for attention.
   */
  private paintTags(rawMatching: TagSuggestion[]): void {
    const matching = this.applyGraphGating(rawMatching);
    this.tagList.replaceChildren();
    if (!matching.length) {
      const empty = el("span", { class: "hint" });
      empty.textContent = !store.tags.length
        ? "No tags yet."
        : rawMatching.length
          ? "Some tags are hidden until a related tag is selected (e.g. pick a Show to see its Characters)."
          : "No tags match.";
      this.tagList.append(empty);
      return;
    }

    const UNCATEGORIZED = "￿:uncategorized"; // sorts after real slugs
    const groups = new Map<string, { label: string; tags: TagSuggestion[] }>();
    for (const tag of matching) {
      const key = tag.category ? `${tag.category.position}:${tag.category.slug}` : UNCATEGORIZED;
      const label = tag.category?.name ?? "Uncategorized";
      if (!groups.has(key)) groups.set(key, { label, tags: [] });
      groups.get(key)!.tags.push(tag);
    }

    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key)!;
      const header = el("span", { class: "dropdown-tag-group-label" });
      header.textContent = group.label;
      const row = el("div", { class: "chip-row" });
      for (const tag of group.tags) {
        const chip = el("span", { class: "chip" });
        // The chip shows the name as typed, but writes the *slug* into the bar:
        // it needs no quoting, is typeable without an accented keyboard, and is
        // the form the backend treats as canonical.
        chip.dataset.tag = tag.slug;
        chip.textContent = tag.name;
        chip.classList.toggle("active", this.hasToken("tag", tag.slug));
        chip.addEventListener("click", () => this.toggleToken("tag", tag.slug));
        row.append(chip);
      }
      this.tagList.append(header, row);
    }
  }
}
