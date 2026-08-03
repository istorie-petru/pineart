# Artboard

A self-hosted art collection: a Pinterest-style masonry grid over your own files, with tags, boards, a tag graph, and optional SearXNG-backed discovery. FastAPI + SQLite backend, Vite + vanilla TypeScript frontend, no SPA framework.

Built from `architecture.md` and `mockups.html`.

## Running it

```bash
./run.sh
```

That is the whole thing. It creates the virtualenv, installs both dependency sets, applies migrations, starts the API and the dev server, and prints the one-time setup token you need to claim a fresh instance. Ctrl-C stops both cleanly. Open <http://localhost:5173>.

Other modes:

```bash
./run.sh --prod       # build the frontend once and serve that — no dev server
./run.sh --seed       # ... and fill an empty database with demo content
./run.sh --discovery  # ... and start SearXNG so the Feed works
./run.sh --docker     # run the Compose stack instead (app on :8080)
./run.sh --test       # backend test suite + frontend typecheck and build
./run.sh --shell      # a subshell with the backend venv on PATH
./run.sh --stop       # stop the Compose stack and any dev SearXNG
```

The default mode runs `vite`'s dev server, which pushes a hot-reload update
over a websocket on every source file change. This app registers no HMR
boundary, so Vite's documented fallback for a change it cannot hot-patch is a
full page reload — meaning any edit saved anywhere under `frontend/src` while a
browser tab is open reloads that tab, dropping scroll position and closing
whatever modal was open. That is exactly what you want while actively
developing the frontend, and surprising the rest of the time. `--prod` builds
the frontend once with `vite build` and serves the static result with
`vite preview` instead: no watcher, no websocket, nothing pushes a reload until
you explicitly rerun `./run.sh --prod`. It still proxies `/api` to the backend
exactly like the dev server does, and combines with `--seed` and `--discovery`
the same way the default mode does.

`--discovery` is a modifier, not a mode: on its own it runs SearXNG in a container published on `127.0.0.1:8888` and points the dev backend at it, and combined with `--docker` it enables the Compose `discovery` profile instead. Either way it generates `searxng/settings.yml` from the tracked example, with a `secret_key` that is created once and then reused across runs — that file is gitignored, since a signing key shared by every checkout is not a secret. Docker is required for this flag and only for this flag. One thing the script cannot do for you: the proxy also checks a `discovery.enabled` setting stored in the database, so turn Discovery on under Settings → Discovery before the Feed appears.

Only `searxng/settings.yml` is bind-mounted into the container, never the directory holding it. The SearXNG image runs `chown -R` over `/etc/searxng` at startup, so a directory mount hands the host directory to a container uid and every later run needs `sudo chown` to write into it again. With a file mount the directory stays yours, and the script rebuilds the file by renaming a new one over it — which needs permission on the directory, not on the file. The consequence for the Compose path is that `searxng/settings.yml` has to exist before `docker compose up`, or Docker will helpfully create a *directory* with that name; `./run.sh --docker --discovery` generates it first for exactly that reason.

Everything it does is idempotent, so it is equally the "first run on a clean checkout" command and the "start it again tomorrow" command. `ARTBOARD_API_PORT`, `ARTBOARD_WEB_PORT` and `ARTBOARD_SEARXNG_PORT` override the defaults if 8000, 5173 or 8888 are taken.

The virtualenv is verified by running one of its console scripts rather than by checking that `backend/.venv/` exists, so a venv that was created elsewhere — copied from another machine, or built inside a container — is detected and rebuilt instead of failing later with `bad interpreter`.

If you would rather drive the two halves yourself, `backend/scripts/dev.sh` and `npm run dev` in `frontend/` still do exactly what they did before.

## What's implemented

The backend is complete: ingest with content and perceptual dedup, WebP derivatives, tags and the co-occurrence graph, manual and saved-search boards, FTS5 search with the `tag:`/`color:`/`orientation:` grammar, trash with a retention purge, the SearXNG proxy, export/import, and single-user login. See `backend/README.md` for how each piece works and why.

The frontend covers every view in the architecture document: the Boards landing view with its profile header and link pills, the Unorganized grid with the search-bar-as-filter-state, board detail with drag-reorder, the item modal with recommendations and keyboard navigation, the crop tool for avatar/banner/cover/freeform, all seven Settings tabs including the d3-force tag graph, and the Feed — which stays hidden until Discovery is configured.

Both deployment paths from §9 exist: systemd units in `backend/deploy/`, and Docker Compose at the repository root.

Authentication is an argon2 password hash with a server-side session cookie, applied to every route except `/api/auth/*` and `/api/health`. First-run setup is gated by a one-time token printed to the server log, so a freshly started instance cannot be claimed by whoever reaches the port first. Set `ARTBOARD_SECURE_COOKIES=true` behind TLS.

## Verifying a change

```bash
cd backend  && .venv/bin/python -m pytest tests -q     # 209 tests
cd frontend && npm run build                           # typecheck + bundle
```

`backend/tests/test_frontend_contract.py` pins the request shapes and response fields the UI actually reads. The frontend has its own types and nothing forces the two to agree at compile time, so a backend rename surfaces there rather than as an undefined value in the browser.

For an end-to-end check, with the backend running and seeded:

```bash
cd frontend && npm run build && npm run smoke
```

That loads the production bundle in jsdom against the live API and asserts the app boots, logs in, renders real items, draws the tag graph, and logs no runtime errors — then reloads it without a session to confirm a logged-out visitor gets the login form and no collection. It is not a substitute for opening the app: jsdom has no layout engine, so it cannot tell you whether the masonry *looks* right. It catches boot failures and contract mismatches that a typecheck cannot.

## Layout

```
backend/            FastAPI app, Alembic migrations, tests, systemd units, Dockerfile
frontend/           Vite + TypeScript app; src/views are the top-level screens
searxng/            Optional SearXNG config for the discovery profile
docker-compose.yml  The §9b deployment path
```
