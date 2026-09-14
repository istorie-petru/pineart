/**
 * Tag entry with fuzzy suggestions.
 *
 * One component used everywhere a tag is typed — the upload dialog, the item
 * modal, bulk tagging, the search filter — so the matching behaves identically
 * in all of them. Suggestions come from `/api/tags/suggest` rather than
 * filtering a cached list, because the ranking depends on the same slug
 * normalization the backend uses for tag identity; reimplementing that in
 * TypeScript would be two rule sets to keep in step.
 */

import { api } from "../api";
import type { TagSuggestion } from "../types";
import { el, tagColor } from "../ui";

export interface TagInputOptions {
  placeholder?: string;
  /** Show the chosen tags as removable chips above the field. */
  chips?: boolean;
  /** Called whenever the chosen set changes (chips mode). */
  onChange?: (names: string[]) => void;
  /** Called when a tag is picked (single-shot mode, no chips). */
  onPick?: (name: string) => void;
  /** Offer "create <query>" when nothing matches exactly. */
  allowCreate?: boolean;
}

export class TagInput {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly chipRow: HTMLElement;
  private readonly menu: HTMLElement;
  private suggestions: TagSuggestion[] = [];
  private highlighted = -1;
  // Not just names: a committed chip needs the matching suggestion's color
  // and category (when it was picked from one — a brand-new tag typed for
  // the first time has neither yet) so `renderChips` can show it in its
  // real color instead of one flat accent for every tag, the way the
  // read-only chips elsewhere (item modal, tags editor) already do.
  private chosen: Array<{ name: string; tag?: TagSuggestion }> = [];
  private requestId = 0;
  private debounce: number | undefined;

  constructor(private readonly options: TagInputOptions = {}) {
    this.element = el("div", { class: "tag-input" });
    this.chipRow = el("div", { class: "tag-input-chips" });
    this.input = el("input", {
      type: "text",
      placeholder: options.placeholder ?? "Add a tag…",
      autocomplete: "off",
      role: "combobox",
      "aria-expanded": "false",
    }) as HTMLInputElement;
    this.menu = el("div", { class: "tag-suggestions", role: "listbox" });

    const field = el("div", { class: "tag-input-field" });
    field.append(this.input, this.menu);
    this.element.append(this.chipRow, field);

    this.input.addEventListener("input", () => this.scheduleFetch());
    // Focus with an empty box shows the most-used tags, which is the useful
    // thing to offer before anything has been typed.
    this.input.addEventListener("focus", () => this.scheduleFetch(0));
    this.input.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.input.addEventListener("blur", () => {
      // Delayed so a click on a suggestion lands before the menu is torn down.
      window.setTimeout(() => this.closeMenu(), 150);
    });
  }

  get values(): string[] {
    return this.chosen.map((entry) => entry.name);
  }

  /** Anything typed but not yet committed, so a half-finished tag is not lost. */
  get pending(): string {
    return this.input.value.trim();
  }

  focus(): void {
    this.input.focus();
  }

  private scheduleFetch(delay = 140): void {
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => void this.fetchSuggestions(), delay);
  }

  private async fetchSuggestions(): Promise<void> {
    const query = this.input.value.trim();
    const id = ++this.requestId;
    try {
      const results = await api.suggestTags(query);
      // Out-of-order responses would otherwise show suggestions for a query the
      // user has already typed past.
      if (id !== this.requestId) return;
      let filtered = results.filter(
        (tag) => !this.chosen.some((entry) => entry.name === tag.name),
      );
      // Typing something that is not an existing tag should offer a gentle
      // nudge, not a wall of options: once there is no exact match, only the
      // single closest tag is worth showing next to "Create <query>". An empty
      // query is browsing (most-used tags), not "adding a new tag", so the
      // full list still applies there.
      const exact = filtered.some((tag) => tag.name.toLowerCase() === query.toLowerCase());
      if (query && !exact) filtered = filtered.slice(0, 1);
      this.suggestions = filtered;
      this.renderMenu(query);
    } catch {
      this.closeMenu();
    }
  }

  private renderMenu(query: string): void {
    this.menu.replaceChildren();
    this.highlighted = -1;

    const exact = this.suggestions.some((tag) => tag.name.toLowerCase() === query.toLowerCase());
    const rows: HTMLElement[] = [];

    for (const [index, tag] of this.suggestions.entries()) {
      const row = el("div", { class: "tag-suggestion", role: "option" });
      const dot = el("span", { class: "tag-dot" });
      dot.style.background = tagColor(tag);
      const name = el("span", { class: "tag-suggestion-name" });
      name.textContent = tag.name;
      const count = el("span", { class: "tag-suggestion-count" });
      count.textContent = tag.usage_count ? String(tag.usage_count) : "";
      row.append(dot, name, count);
      row.addEventListener("mousedown", (event) => {
        // mousedown, not click: blur would close the menu first.
        event.preventDefault();
        this.commit(tag.name);
      });
      row.addEventListener("mouseenter", () => this.highlight(index));
      rows.push(row);
      this.menu.append(row);
    }

    if (this.options.allowCreate !== false && query && !exact) {
      const row = el("div", { class: "tag-suggestion create", role: "option" });
      row.textContent = `Create “${query}”`;
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.commit(query);
      });
      this.menu.append(row);
      rows.push(row);
    }

    if (!rows.length) {
      this.closeMenu();
      return;
    }
    this.menu.classList.add("open");
    this.input.setAttribute("aria-expanded", "true");
  }

  private highlight(index: number): void {
    const rows = [...this.menu.children] as HTMLElement[];
    rows.forEach((row, i) => row.classList.toggle("active", i === index));
    this.highlighted = index;
  }

  private onKeyDown(event: KeyboardEvent): void {
    const rows = [...this.menu.children] as HTMLElement[];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!rows.length) return;
      event.preventDefault();
      const next =
        event.key === "ArrowDown"
          ? Math.min(this.highlighted + 1, rows.length - 1)
          : Math.max(this.highlighted - 1, 0);
      this.highlight(next);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = this.highlighted >= 0 ? rows[this.highlighted] : null;
      if (picked?.classList.contains("create") || !picked) {
        if (this.pending) this.commit(this.pending);
      } else {
        this.commit(this.suggestions[this.highlighted].name);
      }
      return;
    }
    if (event.key === "Escape" && this.menu.classList.contains("open")) {
      // Swallowed so a suggestion list can be dismissed without also closing the
      // modal the input sits in.
      event.stopPropagation();
      this.closeMenu();
      return;
    }
    if (event.key === "," && this.pending) {
      event.preventDefault();
      this.commit(this.pending);
    }
    if (event.key === "Backspace" && !this.input.value && this.chosen.length) {
      this.remove(this.chosen[this.chosen.length - 1].name);
    }
  }

  private commit(name: string): void {
    const clean = name.trim();
    if (!clean) return;
    // Looked up here, not passed in by callers — every call site (a clicked
    // suggestion row, Enter on a highlighted row, "Create …", a trailing
    // comma) already funnels through this one `commit(name)`, and whatever
    // was just fetched into `this.suggestions` is still around at this
    // point, so an exact-name match here is the same tag the person was
    // just looking at, complete with its real color and category.
    const matched = this.suggestions.find((tag) => tag.name.toLowerCase() === clean.toLowerCase());
    this.input.value = "";
    this.closeMenu();

    if (this.options.chips === false) {
      this.options.onPick?.(clean);
      return;
    }
    if (!this.chosen.some((existing) => existing.name.toLowerCase() === clean.toLowerCase())) {
      this.chosen.push({ name: clean, tag: matched });
      this.renderChips();
      this.options.onChange?.(this.values);
    }
    this.input.focus();
  }

  private remove(name: string): void {
    this.chosen = this.chosen.filter((existing) => existing.name !== name);
    this.renderChips();
    this.options.onChange?.(this.values);
  }

  private renderChips(): void {
    this.chipRow.replaceChildren();
    for (const entry of this.chosen) {
      const chip = el("span", { class: "chip active" });
      // A tag picked from suggestions carries its real color/category —
      // shown here the same way `tagColor` renders it everywhere else in
      // the app. A brand-new name with no matching tag yet has no color to
      // show (nothing to look up until it's actually created), so it keeps
      // the plain accent-colored chip look instead.
      if (entry.tag) {
        chip.style.background = tagColor(entry.tag);
        chip.style.borderColor = "transparent";
      }
      chip.append(entry.name);
      const remove = el("button", { type: "button", "aria-label": `Remove ${entry.name}` }, "×");
      remove.addEventListener("click", () => this.remove(entry.name));
      chip.append(remove);
      this.chipRow.append(chip);
    }
  }

  private closeMenu(): void {
    this.menu.classList.remove("open");
    this.menu.replaceChildren();
    this.highlighted = -1;
    this.input.setAttribute("aria-expanded", "false");
  }
}
