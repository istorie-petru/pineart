# Art Board — backend

FastAPI + SQLite implementation of the architecture document: items and ingest,
tags and the tag graph, boards (manual and saved-search), search, trash with
retention, the SearXNG discovery proxy, export/import, and single-user session
authentication.

## Running it

```bash
cd backend
cp .env.example .env          # optional; every value has a working default
./scripts/dev.sh              # creates .venv, migrates, runs uvicorn on :8000
```

On a fresh database the log prints a one-time setup token. Open the app, paste it
in, and choose a password; that claims the instance. See *Authentication* below
for why it works that way.

Interactive API docs are at <http://127.0.0.1:8000/docs>. Everything except
`/api/auth/*` and `/api/health` requires a session cookie, so log in through the
app first — the docs page will then carry the cookie for you.

Tests:

```bash
.venv/bin/python -m pytest tests -q
```

The suite runs against the real Alembic migration rather than
`metadata.create_all`, so schema drift between the models and the migration is a
test failure rather than a surprise on the next upgrade.

## How the pieces fit

An upload goes through one pipeline (`app/services/images.py`): the bytes are
validated by opening them (magic bytes, not the filename), hashed for exact
dedup, perceptually hashed for near-duplicate reporting, stored under
`data/images/<first-2-hex>/<sha256>.<ext>`, and reduced to two WebP derivatives —
a ~400px thumb for the grid and a ~1200px display copy for the modal. Only
`/api/items/{id}/download` ever serves the original. PNGs are converted to
lossless WebP by default, which is a settings toggle with a per-instance
"preserve original bytes" override.

`items.hash` is the SHA-256 of the *incoming* bytes, not of the stored file.
Hashing the stored file would mean that flipping the WebP conversion setting
changes the identity of an unchanged image. Import is the one exception: it
carries the hash from the archive manifest, because the archive contains the
already-normalized file, and re-hashing it would turn every backup restore into
a duplication event.

An artwork can have several files — a better scan, a higher-resolution export, a
revised edit, or a crop of it. `version_of_id` points at the artwork a file belongs to, and only
rows where it is NULL appear in grids, so a set of scans reads as one artwork
rather than as near-duplicates cluttering the collection.
`canonical_version_id` decides which file is displayed; it is a pointer rather
than an `is_canonical` flag on each version precisely because a pointer cannot
end up with two winners or none. A dangling, deleted or foreign pointer falls
back to the artwork's own file, so a stale choice degrades to the original
instead of to a broken image.

The artwork keeps its id, title, tags and board memberships when the displayed
file changes — only the image URLs and file-level metadata come from the chosen
version. That separation is the point: switching which scan is shown must not
move the artwork in the grid or detach it from its boards. Version sets are
deliberately flat; versions of versions are folded into the same artwork, since a
tree buys nothing here and costs cycle checks, recursive queries and a canonical
rule that has to pick a winner across levels. Trashing an artwork takes its
versions with it, and the trash view hides versions whose artwork is also
trashed, so one picture with three scans does not look like four deleted things.

Cropping produces one of those versions rather than a new artwork. §2b describes
a crop as "an ordinary derived item", and that was implemented literally at
first — which meant cropping a picture left a near-duplicate of it sitting in the
feed beside the original. A crop is another view of the same artwork, so it joins
that artwork's versions and becomes the displayed file by default; the original
stays one click away in the versions strip, and the crop can be made
non-displaying at crop time. Profile crops (avatar, banner, board cover) are
assets rather than views, so they are excluded from grids by their
`derivative_target` and stay out of the versions strip too. Migration `0004`
backfills both rules onto collections made before this changed, flattening
crops-of-crops onto the artwork as it goes.

Ordinary uploads are stored under their own content hash, which spreads them
evenly across buckets. Avatar, banner and board-cover crops are the exception:
they are keyed to the photo they came from, so `<source-hash>_avatar.webp` and
its two derivatives sit in the same directory as the `<source-hash>.webp` they
were cut from. A profile picture is then findable from the original instead of
landing in an unrelated bucket named after its own bytes. Because the name is
deterministic, re-cropping the same photo for the same destination rewrites that
file and updates the existing item in place — the avatar keeps its id and no
orphan derivative accumulates each time you adjust it. Derivative paths are read
off `storage_path` rather than recomputed from the hash, since for these two no
longer agree.

Tags keep the name exactly as typed and carry a normalized slug beside it:
"Shōyō Hinata" is stored as written and gets the slug `shoyo-hinata`. The slug
is the identity — two spellings that fold to the same slug are the same tag, so
"Shōyō Hinata", "shoyo hinata" and "Shoyo-Hinata" cannot become three
near-duplicates. The first spelling used wins as the display name; later
variants resolve to it rather than renaming it. Filtering and untagging accept
either form.

Folding is per character, not a blanket ASCII transliteration, because a blanket
one is wrong twice over. Characters that NFKD does not decompose (ł, ø, ß, æ)
would be *deleted* by an ASCII fold, turning "Zażółć" into "zazoc"; they have an
explicit table. And decomposing non-Latin scripts corrupts them: Cyrillic "й"
decomposes to "и" plus a breve, so stripping marks would make "Кандинский" and
"Кандинскии" the same tag. A decomposition is therefore only accepted when it
actually lands on ASCII; otherwise the character is kept, so "日本画" stays
"日本画" — still a perfectly good unique handle.

`GET /api/tags/suggest` powers every tag field in the UI. Ranking is built from
cheap, explainable rules rather than one similarity metric, because a pure
edit-distance score fails exactly the cases that matter: "hin" is a poor
edit-distance match for "Shōyō Hinata" despite being what someone typing that
tag would enter, and word order ("hinata shoyo") destroys it entirely. So an
exact match wins, then a prefix, then a substring, then a word-level match that
makes order and partial words work, and only then difflib — which is there to
catch genuine typos ("landscpae"). Shorter tags outrank longer ones on a tie so
"ink" beats "inktober sketches", and usage count breaks the remainder so the tag
you actually use wins. Matching runs against the slug, so accents are optional.

`POST /api/items/bulk-import` accepts optional `tags` and `board_id` alongside
the files. Applying them in the same request rather than as follow-up calls
matters: uploading and then failing to tag would leave a pile of images with no
indication which ones were meant to carry the labels. Tags apply to duplicates
too, since re-adding a picture you already have *with* tags plainly means "this
one should carry these as well".

Cursor pagination encodes the ordering it belongs to. It did not always, and the
bug that followed is worth recording: the cursor's `added_at` value was parsed
back into a datetime only when no board was involved, so on a dynamic board
SQLite compared the ISO string `2026-07-26T12:00:00` against a column stored as
`2026-07-26 12:00:00`, matched nothing, and returned the first page forever —
the same few images repeating as you paged. With the ordering named inside the
cursor, decoding cannot disagree with the ORDER BY because it no longer infers
anything, and a cursor reused across a sort change is rejected with a 400 rather
than silently interleaving two orderings. `tests/test_pagination.py` walks every
paginated surface and asserts no repeats and no drops.

Search is SQLite FTS5 over title, description and tag names, maintained by
explicit calls at each write site rather than triggers — the `tags` column is
assembled from a join table that triggers can't cheaply see. `python -m app.cli
reindex` rebuilds it if it is ever suspected of being stale.

The search bar grammar *is* the filter state: `tag:landscape tag:impressionism
color:red orientation:portrait some words`. Multiple `tag:` tokens mean AND,
implemented as one `EXISTS` per tag — an `IN (...)` would silently mean OR.
Colour filtering resolves the request to the exact `dominant_color` values
present in the database and passes them as an `IN` list, so it stays inside the
same paginated query instead of becoming a post-filter that would break cursor
pagination.

Any token can be negated with a leading `-`, so `tag:landscape -tag:wip` means
"landscape but not work-in-progress". Exclusion uses `NOT EXISTS` rather than
`NOT IN`, because `NOT IN` against a subquery that can yield NULL returns nothing
at all in SQL — the exclusion would appear to eat the entire collection.
Excluding a colour also has to spare items with no dominant colour recorded,
since something with no colour cannot be that colour.

`is:` answers the questions that are about absence itself, which no amount of
negating a specific tag can express: `is:untagged`, `is:tagged`, `is:titled`,
`is:untitled`. `-is:untagged` is folded into `is:tagged` at parse time, so the
query builder only ever sees the positive form.

Colours match by *family*, in HSV, not by RGB distance. Euclidean distance in RGB
was implemented first and is wrong for this: it fuses hue, saturation and
lightness into one number, so a muted red (`#9f686c`) lands 93 units from a vivid
red (`#e63946`) and fails to match, though anyone asked to sort them puts both
under "red". Named families are hue *ranges* rather than a tolerance around a
representative colour, because perceived families are not evenly sized — blue
spans roughly 200–260° while orange spans about 35°, and on real values two
blues a person calls blue sit 27° apart while red and orange sit 31° apart. No
single symmetric tolerance separates those two cases. Near-greys are matched on
lightness instead, since hue is noise at low saturation; that is what stops the
black swatch from matching every dark colour. A raw `color:#rrggbb` filter still
works and matches a neighbourhood around the given hue.

Boards come in two kinds from one table. Manual boards store membership and order
in `board_items`; dynamic boards store nothing and compute membership at read
time from `board_query_tags`, which is what keeps them current with no
reconciliation job. Writing an arrangement to a dynamic board is rejected rather
than silently ignored.

The tag graph is served as plain nodes and edges (`GET /api/tags/graph`). Edges
are computed from co-occurrence — derived, never stored, so they cannot drift out
of sync. `tag_graph_rules` prunes an edge that a more specific path already
explains (e.g. a Character tag connecting to a Show tag makes its direct edge
to that Show's Category redundant). All physics and layout are the client's
problem.

Deleting sets `is_deleted` and `deleted_at`. `POST /api/trash/purge` hard-deletes
past the retention window (30 days by default) and removes the files; `?force=true`
empties it immediately. `python -m app.cli purge` is the same operation for the
systemd timer.

## Getting started

There are two different things people mean by "getting started" here — try
it out on your own laptop first, or install it for real on a server you'll
actually use day to day. Pick one.

### Just trying it out (your own computer, nothing permanent)

See *Running it* above — `./run.sh` from the repository root (or
`./scripts/dev.sh` here for backend-only work) is exactly this: it creates
the venv, installs both dependency sets, migrates, and starts everything
with no permanent install or access control beyond the setup token. Nothing
is written outside `data/`; delete the checkout and nothing is left behind.
Not meant for exposing to a network — that's the next section.

### Installing it for real (a server, always-on)

**What you need first:**

- A **Debian 12** machine you have root/`sudo` access to — a spare PC, a
  Raspberry Pi running Debian, a $5/mo VPS, or a VM/LXC container in
  something like Proxmox. Not Windows or macOS. No Docker required (and
  none used) — it installs directly as a system service.
- That machine reachable over SSH from the computer you're typing commands
  on.
- Something in front of it that terminates TLS and forwards to
  `127.0.0.1:4173` — either a reverse proxy (`deploy/Caddyfile.example` is a
  working starting point for Caddy) or a Cloudflare Tunnel (see
  [`../deploy/README.md`](../deploy/README.md) for the no-inbound-port,
  no-certificate path). Neither is installed or managed by
  `artboard-ctl` itself, so set one up (before or after the install, in
  either order) and decide how you'll reach it — home network, a VPN like
  [Tailscale](https://tailscale.com/), or publicly.

The app deploys as two systemd services via
[`backend/deploy/artboard-ctl`](deploy/artboard-ctl): `artboard.service`
(uvicorn, `127.0.0.1:8000`) and `artboard-frontend.service` (`vite preview`
serving the built bundle, `127.0.0.1:4173` — it already proxies `/api` to
the backend itself, so whatever sits in front of this box only ever needs to
reach one port). Each deploy builds a fresh, isolated release (backend venv
+ frontend bundle, `npm ci` including devDependencies since `vite preview`
needs `vite` itself at runtime) and atomically swaps a symlink over to it;
nothing is ever edited in place, and a deploy that fails either service's
health check rolls both services back automatically — the site never goes
down mid-upgrade. It also takes an online `sqlite3 .backup` of `db.sqlite3`
before every migration, since a code rollback alone can't undo a bad one —
restore the printed backup path by hand if that ever happens.

#### First install (fresh host)

SSH into the server, then:

```bash
git clone https://github.com/istorie-petru/pineart.git /tmp/bootstrap
sudo /tmp/bootstrap/backend/deploy/artboard-ctl install
rm -rf /tmp/bootstrap   # install already copied itself to /usr/local/bin
```

This creates the `artboard` system user, lays out `/srv/artboard/`, builds
and starts the first release (both services), and enables the daily
trash-purge timer. Point whatever's in front of this box at
`127.0.0.1:4173` — see `deploy/Caddyfile.example` for Caddy or
`../deploy/README.md` for the Cloudflare Tunnel path — and set
`ARTBOARD_SECURE_COOKIES=true` in `/srv/artboard/shared/.env` — already the
default there — once TLS is live. If your public hostname is set (either
path), also uncomment and set `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` in
that same `.env` file to that hostname and `systemctl restart
artboard-frontend` — `vite preview` rejects any `Host` header it doesn't
recognize by default, and answers everything else with a 403.

#### Day to day, once installed

```bash
sudo artboard-ctl update    # deploy latest main: build, migrate, swap, health-check, auto-rollback
sudo artboard-ctl remove    # tear down (destructive, confirms)
```

`update` always deploys the tip of `main`, not a specific tag — the
pre-migration backup is the safety net, not gating deploys behind a release.
Config lives in `/srv/artboard/shared/.env`; edit it and
`systemctl restart artboard artboard-frontend` to change anything.

#### Discovery (SearXNG), natively

```bash
sudo artboard-ctl install --discovery   # first install, or add it later the same way
```

Sets up SearXNG the same way [its own non-Docker install docs](https://docs.searxng.org/admin/installation-searxng.html)
do: a dedicated `searxng` system user, a git clone of upstream SearXNG in its
own venv (entirely separate from the app's backend venv), served by `uwsgi`
bound to `127.0.0.1:8888` as `artboard-searxng.service`. No Docker, no nginx,
no Redis/Valkey — this app's `searxng/settings.yml.example` already runs with
`limiter: false`, so there's no rate-limiter dependency to stand up either.
`ARTBOARD_SEARXNG_URL` is set in `/srv/artboard/shared/.env` automatically;
turn Discovery on under Settings → Discovery in the app afterwards, same as
locally. Once enabled, every later `sudo artboard-ctl update` keeps SearXNG's
source and dependencies current too — you don't need to pass `--discovery`
again. `sudo artboard-ctl remove` tears it down along with everything else.

## Deployment (Docker Compose)

The alternative path, from the repository root:

```bash
docker compose up -d --build                       # app on :8080
docker compose --profile discovery up -d --build    # also start SearXNG
docker compose logs backend | grep -A2 "setup token"
```

`./run.sh --docker --discovery` from the repository root wraps the second form
and generates `searxng/settings.yml` with a real `secret_key` for you.

Same service boundaries as the native path: only the proxy publishes a port,
and SearXNG is reachable solely through the backend. If you configure SearXNG by
hand instead, copy `searxng/settings.yml.example` to `searxng/settings.yml` and
replace the placeholder `secret_key` with `openssl rand -hex 32` — and note that
the `formats: [json]` entry there is not optional, since SearXNG ships with JSON
output disabled and the proxy has nothing to parse without it.

Create that file *before* the first `docker compose up`. The compose file mounts
the single settings file rather than the directory around it, because the image
chowns everything under `/etc/searxng` to its own user at startup and a directory
mount passes that chown through to the host — locking the repository directory
behind root for every subsequent run. Docker creates a missing bind-mount source
as an empty directory, so a missing `settings.yml` turns into a directory of that
name and SearXNG starts with default settings and no JSON output.

Note that `docker compose down` alone will not remove a SearXNG started under
the `discovery` profile; pass the profile on the way down too, as
`./run.sh --stop` does.

## Authentication

Single-user login with an argon2 password hash and a session cookie (§9c). Auth
is attached at router-include time in `main.py`, not per-endpoint, so a new route
is protected by default and a forgotten decorator cannot open a hole. Only
`/api/auth/*` and `/api/health` are public — health because that is what a
monitor or `systemctl` checks.

Four decisions in `services/auth.py` that each rule out a simpler option:

**Server-side sessions, not a stateless signed cookie.** A signed cookie cannot
be revoked, so "log out everywhere" and "someone took my laptop" both mean
waiting for expiry. A row can be deleted.

**Session tokens are stored hashed.** The cookie holds the token, the database
holds its SHA-256; a leaked backup therefore contains no usable sessions.
SHA-256 rather than argon2 is deliberate here — the token is 256 bits of CSPRNG
output with no guessable structure to slow-hash, and this check runs on every
request.

**First-run setup requires a one-time token printed to the log.** Without it,
the gap between "service starts" and "owner sets a password" is a window in
which anyone who can reach the port claims the instance. Several well-known
self-hosted apps leave that window open; closing it costs one log line to copy.
The token is regenerated on restart and becomes meaningless once a password
exists.

**CSRF is handled by `SameSite=Lax`, not by tokens.** The cookie is simply not
sent on cross-site POST/PUT/DELETE, so a hostile page cannot ride an existing
session, while ordinary top-level navigation still works. A token scheme would
add a moving part for no additional protection at this shape of app.

Lost the password? `python -m app.cli set-password` on the server. It asks for no
current password on purpose: whoever can run it can already read the database
file, so a check would be theatre. It revokes every session, so an
already-open browser is not a way around it.

Set `ARTBOARD_SECURE_COOKIES=true` in production. It is off by default because a
`Secure` cookie is silently dropped over plain HTTP, which presents as a login
that "does nothing" rather than as a configuration mistake — the systemd unit and
the compose file both turn it on.

## Other hardening

Uploads are validated by decoding them rather than trusting the content type;
filenames are derived from the content hash, which closes path traversal by
construction rather than by sanitizing; upload size is capped; and
`POST /api/discover/save` resolves the target hostname and refuses private,
loopback and link-local addresses — without that check it would be a server-side
request forgery primitive that fetches internal URLs on request.

The argon2 password hash lives in the `settings` table but is filtered out of
`GET /api/settings` and rejected by `PUT /api/settings`; there is a test for
both, because "secret stored in the same table as preferences" is exactly the
shape of mistake that leaks one.

## Deviations from the architecture document

Two columns were added that the document's data model doesn't list. `items.derivative_target`
records which crop preset produced a derived item, which §2b asks for in prose
("tags the resulting derivative so it's easy to find later") without giving it a
column. `link_directory.icon` stores the choice from the mockup's icon picker.

Some endpoints beyond §5 exist because the mockup needs them:
`GET /api/items/{id}/recommendations` (the modal's recommendation strip),
`GET /api/items/on-this-day` (the banner), `GET /api/items/{id}/file/{thumb|display}`
(the derivative URLs), `GET /api/tags/{id}/items` (the graph editor's
"View images" jump), `DELETE /api/trash/{id}` (the per-card Purge button, which
the mockup shows and §5 has no endpoint for), and the `/api/auth/*` group.

`POST /api/items/{id}/crop` takes an optional `output_width`, which is the
"resize" half of §6.4's "crop/resize" — §5 defines the crop payload without it.
Only the width is accepted and the height is derived, so the stored image always
has exactly the ratio that was selected. Downscale only: enlarging invents detail
the source never had, so it is refused rather than silently interpolated.

`GET /api/discover/templates` and the `discovery.query_template` /
`discovery.templates` settings implement search templates. The Feed's box takes
the subject alone — "Shōyō Hinata" — and the template supplies the boilerplate
that makes image search useful, with `{query}` marking where the subject goes.
Expansion happens server-side so the view stays what it appears to be, and the
expanded string is returned in the response so the Feed can show what was
actually searched. A template without `{query}` is rejected: it would replace the
search rather than decorate it, and every search would return the same results.

FTS5 is SQLite-specific, as the architecture document already notes: a fork
swapping in Postgres reimplements `app/services/search.py` against `tsvector` and
nothing else.

The near-duplicate scan in `app/services/ingest.py` is a linear pass over stored
pHashes — a few milliseconds of integer XOR at the scale this targets. If a
collection ever grows past the point where that holds, that one function is what
gets replaced with a BK-tree, and nothing else changes.
