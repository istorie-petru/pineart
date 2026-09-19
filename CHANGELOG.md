# Changelog

All notable changes to this project are documented here, one entry per tagged
release — so "should I update" is an informed decision instead of a leap of
faith (see `advance.md` §3). Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.1.0] - 2026-09-20

### Added
- A dedicated Links page (`#/links`), replacing the pill row that used to
  live under the Boards profile header: a grouped grid of status-cards
  (preview image, icon, title, and a kebab menu for uploading a custom image
  or editing details), with each link's group shown both as a section header
  and as a label under its card.
- Links auto-fetch a preview image from their own URL's
  `og:image`/`twitter:image` on creation (and on a later URL edit, if none
  was ever set) — the same "unfurl" a chat app does when you paste a link.
  Best-effort and silent: a slow or broken site never blocks creating the
  link, and a manually uploaded cover always wins over an auto-fetched one.

### Changed
- Redesigned the item modal's footer to match every other modal's own
  action-row shape (spacer-separated secondary/primary actions) and dropped
  the citation-copy button from it.

### Internal
- `Link.category` renamed to `Link.group_name` (it was never surfaced in the
  UI under its old name).
- The SSRF guard Discover's `/api/discover/save` already used for
  server-side URL fetches is now shared (`services/net.py`) with the new
  link-preview fetch.

## [1.0.0] - 2026-09-19

### Changed
- Replaced `backend/deploy/deploy.sh` (git-checkout-a-tag-in-place) and the
  tracked `artboard.service`/`artboard-purge.{service,timer}` units with
  `backend/deploy/artboard-ctl`: a self-installing `install`/`update`/`remove`
  script that deploys the tip of `main` into atomic release/symlink
  directories under `/srv/artboard/`, takes an online `sqlite3 .backup`
  before every migration, and auto-rolls-back code on a failed health check.
  `Caddyfile.example` now points at `/srv/artboard/current/frontend/dist`.

### Added
- An "Untagged" section on the Boards page, below the board grid, showing a
  live feed of items with zero tags (backed by the existing
  `GET /api/items/untagged` endpoint) so untagged items surface right where
  you're already organizing.
- Atomic file writes for stored images (temp file + `os.replace`), so a crash
  mid-write can no longer leave a half-written original at its real path.
- `/api/maintenance/integrity` — re-verifies every stored original is still a
  decodable image, surfacing disk corruption/bit rot before it shows up as a
  broken image in the grid.
- `/api/maintenance/reconcile` — compares the images directory against the
  database in both directions and reports drift (orphaned files, missing
  files) without deleting anything itself.
- `/api/maintenance/near-duplicates` — a retroactive pHash scan over the
  whole collection, for near-duplicates that predate ingest-time dedup.
- Tag merge (`POST /api/tags/{id}/merge`) — distinct from rename: collapses
  two tag identities into one, reassigning every item and deleting the
  merged-away tag in a single transaction.
- Orphaned-tag listing (`GET /api/tags/unused`) and a Settings → Tags →
  Cleanup panel to review and delete unused tags and near-duplicate pairs.
- Citation/provenance export (`GET /api/items/{id}/citation`,
  `GET /api/boards/{id}/citation`) — structured, copy-pasteable reference
  data (title, artist tag, date added, source) for an item or a whole board.
- A printable board index: a `@media print` stylesheet plus a per-board
  "Print" action that lays out thumbnails and citation metadata for a
  physical reference sheet.
- A visible version string, read live from `/api/health` and shown in
  Settings → Backup.
- An "Undo" toast whenever an item (or a bulk selection) is moved to trash.
- A connectivity banner shown when the backend becomes unreachable
  mid-session, with automatic recovery once `/api/health` responds again.
- A styled error view for "board not found", boot-time backend
  unreachability, and as a last-resort catch for an otherwise-uncaught error
  — replacing a blank screen or a raw toast in each case.
- Focus trapping in every modal (Tab/Shift+Tab now cycles within the modal
  instead of leaking to the page behind it), plus focus restored to whatever
  opened the modal on close.
- Shift+click range-select and Ctrl/Cmd+click toggle-select on grid cards,
  and marquee (click-drag) selection over empty grid area — all additive to
  the existing "Bulk select" entry point, not replacements for it.
- Right-click (desktop) and long-press (touch) open the same menu as a
  card's ⋮ button, at the cursor/touch point. On touch this is also a bug
  fix: the previous hover-reveal select checkbox never fired on a touch
  device at all, making bulk-select desktop-only by accident.
- Themed scrollbars, a shimmer on the thumbnail placeholder while it loads,
  a fade-out transition when a card leaves a filtered view, and a `grabbing`
  cursor state on draggable cards — all following existing `--transition-fast`
  timing rather than introducing one-off durations.
- "Remember last-used context": the last board picked in "Add to board",
  the last search/sort used in Unorganized, and the last freeform crop
  aspect ratio all persist across visits in this browser.
- A first-run flow: the initial setup screen now also asks for an optional
  display name.
- `backend/deploy/deploy.sh` — a single script covering fetch → tag checkout
  → stop service → consistent backup → dependency install → migrate →
  frontend build → restart → health poll, replacing a manual update
  checklist.
- `.github/workflows/ci.yml` (lint/build/test on push) and
  `.github/dependabot.yml` (dependency update PRs for pip and npm).
- A documented note (Settings → Backup) that an export leaving this machine
  should be encrypted at that point — nothing here does that automatically.

### Fixed
- Upload failures now report which file failed and the specific reason
  (unsupported format, corrupt file, over the size limit) rather than a
  filename with no explanation.

## [0.2.0] and earlier

Predates this changelog. See git history for the full record; the backend
and frontend both existed in a working state, including ingest/dedup, tags
and the co-occurrence graph, boards, search, trash, the SearXNG discovery
proxy, export/import, and single-user login.
