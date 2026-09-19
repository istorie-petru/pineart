/**
 * Links — a grid of `.status-card` widgets (design-system unification,
 * 2026-09-19: reuses settings.ts's own status-card grid rather than a new
 * card shape), grouped into sections. Links used to live as a pill row under
 * the Boards profile header; they now have this page to themselves, with no
 * link UI left in the Feed or Boards views.
 *
 * Grouping is `Link.group_name` (a plain free-text label, set from
 * linkModal.ts) — it shows up twice per the request that drove this page:
 * once as a section header, and once again as a small label under each card
 * in case cards ever get reordered independently of their section.
 */

import { api } from "../api";
import { toggleActionMenu } from "../components/actionMenu";
import { openLinkModal } from "../components/linkModal";
import { icon } from "../icons";
import type { Link } from "../types";
import { el, emptyStateMessage, guard, toast } from "../ui";

const UNGROUPED = "Ungrouped";

function groupLinks(links: Link[]): Map<string, Link[]> {
  const groups = new Map<string, Link[]>();
  for (const link of links) {
    const key = link.group_name?.trim() || UNGROUPED;
    const bucket = groups.get(key);
    if (bucket) bucket.push(link);
    else groups.set(key, [link]);
  }
  // Named groups first (alphabetical), Ungrouped always last — a catch-all
  // reads better trailing the sections someone deliberately named.
  return new Map(
    [...groups.entries()].sort(([a], [b]) => {
      if (a === UNGROUPED) return 1;
      if (b === UNGROUPED) return -1;
      return a.localeCompare(b);
    }),
  );
}

function linkCard(link: Link, onChanged: () => void): HTMLElement {
  const card = el("div", { class: "status-card link-card" });

  const cover = el("div", { class: "link-card-cover" });
  if (link.cover_url) cover.style.backgroundImage = `url(${link.cover_url})`;
  else cover.innerHTML = icon("image", true);
  card.append(cover);

  const header = el("div", { class: "status-card-header" });
  header.append(el("span", { class: "status-card-title" }, `${icon(link.icon ?? "globe", true)} ${link.title}`));

  const coverInput = el("input", { type: "file", accept: "image/*" }) as HTMLInputElement;
  coverInput.hidden = true;
  // `coverInput` lives inside `card` (below), so the synthetic click that
  // `.click()` fires on it bubbles right back up to the card's own "open the
  // link" listener unless stopped here -- without this, picking "Upload
  // custom image" opened the link instead of the file picker.
  coverInput.addEventListener("click", (event) => event.stopPropagation());
  coverInput.addEventListener(
    "change",
    guard(async () => {
      const file = coverInput.files?.[0];
      coverInput.value = "";
      if (!file) return;
      await api.setLinkCover(link.id, file);
      toast("Preview image updated");
      onChanged();
    }),
  );

  const menuBtn = el("button", { class: "icon-btn", "aria-label": `${link.title} actions` }, icon("kebab", true));
  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleActionMenu({
      trigger: menuBtn,
      ariaLabel: `${link.title} actions`,
      sections: [
        {
          items: [
            { action: "cover", label: "Upload custom image", icon: "upload" },
            { action: "edit", label: "Edit details", icon: "edit" },
          ],
        },
      ],
      onAction: (action) => {
        if (action === "cover") coverInput.click();
        else if (action === "edit") openLinkModal(link, onChanged);
      },
    });
  });
  header.append(menuBtn);
  card.append(header, coverInput);

  if (link.group_name?.trim()) {
    const groupLabel = el("p", { class: "status-card-desc link-card-group" });
    groupLabel.textContent = link.group_name;
    card.append(groupLabel);
  }

  // The card itself opens the link; the kebab button already stops its own
  // click from bubbling here, same convention as Grid's card menu.
  card.addEventListener("click", () => window.open(link.url, "_blank", "noreferrer,noopener"));
  card.style.cursor = "pointer";

  return card;
}

export function renderLinksView(root: HTMLElement): () => void {
  const section = el("section", { class: "view active" });
  const heading = el("h2", { class: "view-title" });
  heading.textContent = "Links";
  const description = el("p", { class: "view-desc" });
  description.textContent = "Outbound links to your shops, profiles and portfolios, grouped however you like.";

  const addBtn = el("button", { class: "btn btn-tonal" }, `${icon("plus", true)} Add link`);
  const headerRow = el("div", { style: "display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;" });
  headerRow.append(description, addBtn);

  const body = el("div", { class: "links-body" });
  section.append(heading, headerRow, body);
  root.replaceChildren(section);

  const render = guard(async () => {
    const links = await api.listLinks();
    body.replaceChildren();

    if (!links.length) {
      body.append(emptyStateMessage("No links yet — add one to get started."));
      return;
    }

    for (const [groupName, groupItems] of groupLinks(links)) {
      const groupSection = el("div", { class: "links-group" });
      const groupTitle = el("h3", { class: "links-group-title" });
      groupTitle.textContent = groupName;
      const grid = el("div", { class: "status-card-grid" });
      for (const link of groupItems) grid.append(linkCard(link, () => void render()));
      groupSection.append(groupTitle, grid);
      body.append(groupSection);
    }
  });

  addBtn.addEventListener("click", () => openLinkModal(null, () => void render()));

  void render();

  return () => undefined;
}
