# Artboard

A self-hosted art collection: a Pinterest-style masonry grid over your own
files, with tags, a tag graph, manual and saved-search boards, full-text
search, and optional SearXNG-backed discovery. No cloud account, no
subscription — just a folder of images and a database file, on hardware you
control.

## What it is

- **Single-user by design.** One argon2 password hash, one server-side
  session cookie, applied to every route except `/api/auth/*` and
  `/api/health`. First-run setup is gated by a one-time token printed to the
  server log, so a freshly started instance can't be claimed by whoever
  reaches the port first.
- **Runs entirely from one tree**, with no external services beyond the
  optional SearXNG discovery backend. Self-host it where you like.
- **FastAPI + SQLite backend, Vite + vanilla TypeScript frontend** — no SPA
  framework, no build step for the styles, and the database is a single
  local file. Built from `architecture.md` and `mockups.html`.
- **The current version is 0.2.0** — see [`CHANGELOG.md`](CHANGELOG.md) for
  what changed and when.

## Is this for you?

This is a self-hosted app: you run it on your own server (a spare computer,
a Raspberry Pi, a cheap VPS, a Proxmox VM/LXC) rather than signing up for a
hosted service. If you're comfortable running a few terminal commands over
SSH and don't mind occasionally reading a log file, you can run this. If
"self-hosted" and "systemd service" are unfamiliar terms, read the
[Getting started](#getting-started) walkthrough below first — it explains
each one as it comes up — before deciding whether to proceed.

## The stack

| Layer | Technology |
|---|---|
| App framework | **FastAPI** (Python 3.12+) + **Uvicorn** |
| Database | **SQLite** (a single local file — `db.sqlite3` + an `images/` folder) |
| Frontend | Vanilla **TypeScript + CSS**, built with **Vite** — no framework |
| Migrations | **Alembic** |
| Optional discovery backend | **SearXNG** (self-hosted metasearch, proxied by the backend) |
| Testing | **pytest** (backend) + Vite's typecheck/build + a jsdom smoke test (frontend) |

## Repository layout

```
backend/            FastAPI app, Alembic migrations, tests
  deploy/           artboard-ctl, Caddyfile.example — see "Getting started" below
frontend/           Vite + TypeScript app; src/views are the top-level screens
searxng/            Optional SearXNG config for the discovery profile
deploy/             Cloudflare Tunnel + firewall for the native deploy path — see deploy/README.md
docker-compose.yml  The Docker Compose deployment path
```

## Getting started

There are two different things people mean by "getting started" here — try
it out on your own laptop first, or install it for real on a server you'll
actually use day to day. Pick one.

### Just trying it out (your own computer, nothing permanent)

```bash
git clone https://github.com/istorie-petru/pineart.git
cd pineart
./run.sh
```

That is the whole thing. It creates the virtualenv, installs both dependency
sets, applies migrations, starts the API and the dev server, and prints the
one-time setup token you need to claim a fresh instance. Ctrl-C stops both
cleanly. Open <http://localhost:5173>. Nothing is written outside `data/`;
delete the checkout and nothing is left behind.

Other modes:

```bash
./run.sh --prod       # build the frontend once and serve that — no dev server
./run.sh --seed       # ... and fill an empty database with demo content
./run.sh --discovery  # ... and start SearXNG (in Docker) so the Feed works
./run.sh --docker     # run the Compose stack instead (app on :8080)
./run.sh --test       # backend test suite + frontend typecheck and build
./run.sh --shell      # a subshell with the backend venv on PATH
./run.sh --stop       # stop the Compose stack and any dev SearXNG
```

Everything it does is idempotent, so it is equally the "first run on a clean
checkout" command and the "start it again tomorrow" command. See
[`backend/README.md`](backend/README.md) for what each mode actually runs
and why (`--discovery` in particular only needs Docker for that one flag —
everything else here is plain Python/Node).

Run the test suite (optional, for anyone editing the code):

```bash
cd backend  && .venv/bin/python -m pytest tests -q     # 209 tests
cd frontend && npm run build                           # typecheck + bundle
```

See [Verifying a change](#verifying-a-change) below for the full story,
including the end-to-end smoke test.

### Installing it for real (a server, always-on)

**What you need first:**

- A **Debian 12** machine you have root/`sudo` access to — a spare PC, a
  Raspberry Pi running Debian, a $5/mo VPS, or a VM/LXC container in
  something like Proxmox. Not Windows or macOS. No Docker required (and
  none used for the app itself) — it installs directly as a system service.
- That machine reachable over SSH from the computer you're typing commands
  on.
- A rough idea of how you'll reach it afterward: a reverse proxy you manage
  yourself (Caddy or nginx, terminating TLS), or a Cloudflare Tunnel (no
  inbound port, no certificate to renew — see
  [`deploy/README.md`](deploy/README.md)). Decide this before or after the
  install, in either order.

The app deploys as two systemd services via
[`backend/deploy/artboard-ctl`](backend/deploy/artboard-ctl): `artboard`
(the backend, on `127.0.0.1:8000`) and `artboard-frontend` (`vite preview`
serving the built bundle on `127.0.0.1:4173`, which already proxies `/api`
to the backend itself — whatever sits in front of this box only ever needs
to reach one port). Each deploy builds a fresh, isolated release and
atomically swaps a symlink over to it; nothing is ever edited in place, and
a deploy that fails either service's health check rolls both back
automatically — the site never goes down mid-upgrade. It also takes an
online `sqlite3 .backup` of `db.sqlite3` before every migration, since a
code rollback alone can't undo a bad one.

#### First install (fresh host)

SSH into the server, then:

```bash
git clone https://github.com/istorie-petru/pineart.git /tmp/bootstrap
sudo /tmp/bootstrap/backend/deploy/artboard-ctl install
rm -rf /tmp/bootstrap   # install already copied itself to /usr/local/bin
```

(`artboard-ctl` ships inside this repo rather than a separate infra repo,
and figures out its own repo URL from the clone it's running from — that's
why you clone first and run the script *from inside* that clone, rather
than downloading just the one script file.)

`install` will:

1. Create a dedicated `artboard` system user and the `/srv/artboard/` folder
   layout it lives in (`releases/`, `current`/`previous` symlinks, and a
   `shared/` directory for config and data that survives every deploy).
2. Generate `/srv/artboard/shared/.env` — the app's one config file — with
   sensible production defaults (`ARTBOARD_SECURE_COOKIES=true`, empty CORS
   origins) and everything else left as commented-out examples.
3. Install and enable the `artboard.service` and `artboard-frontend.service`
   systemd units (systemd is Debian's standard "keep this program running,
   restart it if it crashes or the server reboots" mechanism — no separate
   install step needed, it's already on the machine), plus a daily
   trash-purge timer.
4. Build and start the first release.

By the end, the app is running behind `127.0.0.1:4173`. Point your reverse
proxy or Cloudflare Tunnel at that port (see `backend/deploy/Caddyfile.example`
or [`deploy/README.md`](deploy/README.md)), open the resulting URL in a
browser, and you'll land on the one-time **setup page**: paste in the token
printed to `sudo journalctl -u artboard`, pick a password, and that's your
login from then on.

Deploying to a fork, or from a separate infra repo instead of in-tree, works
the same way but with an explicit override: `sudo ARTBOARD_REPO_URL=<url> -E
artboard-ctl install`.

#### Updating (every deploy after that)

```bash
sudo artboard-ctl update
```

This clones the latest `main`, builds it into a new timestamped release
under `/srv/artboard/releases/`, backs up the database, runs migrations,
atomically swaps the `current` symlink to it, restarts both services, and
health-checks them over HTTP. If either health check fails, it swaps
`current` back to the previous release, restarts again, and exits
non-zero — the bad release never stays live. Releases beyond the last 5 are
pruned automatically. Config in `shared/.env` and data in `shared/data/`
live outside every release directory, so neither is touched by a swap.

#### Continuous deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs `sudo
/usr/local/bin/artboard-ctl update` over SSH on every push to `main`, using
the `SSH_HOST`, `SSH_USER`, and `SSH_KEY` repo secrets. It's a thin
trigger only — every actual deploy step lives in `artboard-ctl` itself, not
in the workflow, so a deploy from CI is never different from SSHing in and
running the command by hand.

#### Enabling Discovery (SearXNG)

Discovery (the Feed) needs a SearXNG instance for the backend to proxy to.
On this deploy path, add it with:

```bash
sudo artboard-ctl install --discovery
```

This works whether run at first install or added later. It sets up SearXNG
the fully native way — no Docker anywhere on this deploy path — following
[SearXNG's own non-Docker install docs](https://docs.searxng.org/admin/installation-searxng.html):
a dedicated `searxng` system user, a git clone of upstream SearXNG in its
own venv (entirely separate from the app's backend venv), served by `uwsgi`
bound to `127.0.0.1:8888` as `artboard-searxng.service`. `ARTBOARD_SEARXNG_URL`
is set in `shared/.env` automatically; every later `artboard-ctl update`
keeps SearXNG current too, without needing `--discovery` again. One thing
this can't do for you: the proxy also checks a `discovery.enabled` setting
stored in the database, so turn Discovery on under Settings → Discovery
before the Feed appears. Full details, including how this differs from the
Docker-based `./run.sh --discovery`, are in
[`backend/README.md`](backend/README.md#discovery-searxng-natively).

#### Removing

```bash
sudo artboard-ctl remove
```

Stops and disables the services, deletes the unit files, removes the
`artboard` (and, if Discovery was enabled, `searxng`) system user, and
wipes `/srv/artboard` (all releases, data, and backups) — after a `type
'yes'` confirmation prompt.

### Security note (read this before exposing the app to a network)

The login screen (from the one-time setup page above) only stops someone
from *using* the app without your password — it does not encrypt the
connection on its own. Two supported ways to add TLS:

- **A Cloudflare Tunnel** — no inbound port, no certificate to renew. Full
  walkthrough, including a `ufw` lockdown script, in
  [`deploy/README.md`](deploy/README.md).
- **Caddy or nginx** in front of `127.0.0.1:4173`, terminating TLS —
  `backend/deploy/Caddyfile.example` is a working starting point.

Either way, once TLS is live, confirm `ARTBOARD_SECURE_COOKIES=true` in
`/srv/artboard/shared/.env` (already the default there) — a Secure cookie
is silently dropped over plain HTTP, so this only matters once TLS is
actually in front of the app. Don't expose `127.0.0.1:4173` or `:8000`
directly to the internet without one of the above in front of it.

### Troubleshooting

- **Can't reach the app after install.** Check both services:
  `sudo systemctl status artboard artboard-frontend`. Logs:
  `sudo journalctl -u artboard -f` / `-u artboard-frontend -f`.
- **403 "This host is not allowed" through a reverse proxy/tunnel.** `vite
  preview` rejects any `Host` header it doesn't recognize by default.
  Uncomment `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` in
  `/srv/artboard/shared/.env`, set it to your public hostname, and
  `sudo systemctl restart artboard-frontend`.
- **Update seemed to fail / site is down after `artboard-ctl update`.** It
  should have already rolled itself back — re-check `sudo systemctl status
  artboard artboard-frontend`. If it's still down,
  `sudo journalctl -u artboard -n 100` shows what the last release logged
  before failing its health check.
- **Forgot the login password.** From the server:
  `sudo -u artboard bash -c "cd /srv/artboard/current/backend && set -a; source /srv/artboard/shared/.env; set +a; .venv/bin/python -m app.cli set-password"`.
  This revokes every existing session, so a forgotten password can't be
  worked around by an already-open browser — it does not touch your images
  or tags.
- **Discovery/Feed not appearing.** Confirm `ARTBOARD_SEARXNG_URL` is set in
  `shared/.env`, that `sudo systemctl status artboard-searxng` is healthy,
  and that Discovery is turned on under Settings → Discovery in the app —
  the last step lives in the database, not a config file, and nothing sets
  it automatically.
- **Something else.** Check [`backend/README.md`](backend/README.md) for
  how each backend piece works, or open a GitHub issue.

## Verifying a change

```bash
cd backend  && .venv/bin/python -m pytest tests -q     # 209 tests
cd frontend && npm run build                           # typecheck + bundle
```

`backend/tests/test_frontend_contract.py` pins the request shapes and
response fields the UI actually reads. The frontend has its own types and
nothing forces the two to agree at compile time, so a backend rename
surfaces there rather than as an undefined value in the browser.

For an end-to-end check, with the backend running and seeded:

```bash
cd frontend && npm run build && npm run smoke
```

That loads the production bundle in jsdom against the live API and asserts
the app boots, logs in, renders real items, draws the tag graph, and logs
no runtime errors — then reloads it without a session to confirm a
logged-out visitor gets the login form and no collection. It is not a
substitute for opening the app: jsdom has no layout engine, so it cannot
tell you whether the masonry *looks* right. It catches boot failures and
contract mismatches that a typecheck cannot.

## Other ways to run this

- **Docker Compose**, at the repository root — no systemd, no host-level
  Python/Node install, only the frontend container publishes a port. See
  [`backend/README.md`](backend/README.md#deployment-docker-compose).
- **A Cloudflare Tunnel in front of the native deploy**, instead of Caddy —
  see [`deploy/README.md`](deploy/README.md) for the full setup, an
  architecture diagram, and verification steps.

All deployment paths run the same code the same way conceptually: build
once, run without a dev server or `--reload`. Concretely, what
`artboard-ctl` runs on the server is the same pair of commands
`./run.sh --prod` runs locally — kept alive as persistent, restarting
systemd services instead of two foreground processes under one script.

## Versioning

The current version is tracked in [`VERSION`](VERSION) at the repository
root; [`CHANGELOG.md`](CHANGELOG.md) has one entry per tagged release,
loosely following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
[`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) is what actually gets run
through before a version is tagged.
