# Deploying Pineart with a Cloudflare Tunnel

This directory adds a third way to get Pineart onto the internet, on top of
the two already documented in [`backend/README.md`](../backend/README.md)
(native + Caddy) and the repository-root `docker-compose.yml`. It doesn't
replace `backend/deploy/artboard-ctl` -- that script still builds, migrates,
and runs the app as systemd services exactly as documented there. What
changes here is what sits *in front of* those services: a Cloudflare Tunnel
instead of a reverse proxy, plus a firewall script and a CI trigger to go
with it.

This README does not repeat the `artboard-ctl install` bootstrap -- see
[`backend/README.md`'s "Installing it for real"](../backend/README.md)
section for that. Everything below assumes the app is already running on
`127.0.0.1:8000` (backend) and `127.0.0.1:4173` (frontend).

## How this relates to `./run.sh`

`artboard-ctl` doesn't call `run.sh` -- it's a separate script for a separate
environment (a real server, not your laptop) -- but it runs the exact same
two commands `./run.sh --prod` runs locally, just kept alive as persistent
systemd services instead of two foreground processes under one script:

| | `./run.sh --prod` (local) | `artboard-ctl` (this deploy) |
| --- | --- | --- |
| Backend | `uvicorn app.main:app --host 127.0.0.1 --port 8000` (no `--reload`) | identical command, run as `artboard.service` |
| Frontend build | `npm run build` (`vite build`) once | identical, once per release directory |
| Frontend serve | `npm run preview -- --port 5173 --strictPort` (`vite preview`) | `vite preview --host 127.0.0.1 --port 4173 --strictPort`, run as `artboard-frontend.service` |
| Migrations | `alembic upgrade head` before starting | identical, plus an online `sqlite3 .backup` snapshot first |

The one deliberate difference is the frontend port: `run.sh` defaults
`ARTBOARD_WEB_PORT` to `5173` (matching the dev server, so switching between
`./run.sh` and `./run.sh --prod` doesn't change the URL you have open), while
`artboard-ctl` uses vite's own default preview port, `4173`, since nothing
here needs to match a dev server that was never running.

What this deploy deliberately leaves out entirely: `--seed` (demo content
has no place on a real instance) and `--docker` (this is the non-container
path; see the root `docker-compose.yml` if you want that one instead).

`--discovery` *does* have an equivalent -- `sudo artboard-ctl install
--discovery` -- but it isn't the same mechanism as `run.sh`'s. `run.sh`
runs SearXNG in a Docker container even outside `--docker` mode, since
that's the simplest way to get it running on a laptop. This deploy has no
Docker anywhere, so `--discovery` here installs SearXNG the fully native
way instead: its own system user, its own venv (built from SearXNG's
upstream source, entirely separate from the app's backend venv), served by
`uwsgi` as `artboard-searxng.service` on `127.0.0.1:8888`. Same
`searxng/settings.yml.example` (`limiter: false`, so no Valkey/Redis to
stand up either), same `ARTBOARD_SEARXNG_URL` wiring, same "turn it on
under Settings -> Discovery" last step -- see
[`backend/README.md`'s "Discovery (SearXNG), natively"](../backend/README.md#discovery-searxng-natively)
for the full walkthrough. It's optional and independent of everything else
in this directory: add it before or after setting up the tunnel, in either
order, with `firewall.sh` already denying inbound `8888` either way.

## Why a tunnel instead of Caddy/nginx

`backend/deploy/Caddyfile.example` is still there and still works if you'd
rather run a reverse proxy. The tunnel is a different trade-off:

- **No inbound port at all.** `cloudflared` makes an outbound connection
  from this host to Cloudflare's edge; nothing needs to accept connections
  on 80/443. `deploy/firewall.sh` can therefore deny every inbound port
  except SSH.
- **No certificates to renew.** Cloudflare's edge terminates TLS. There is
  no Let's Encrypt renewal job, no `certbot`, nothing that can silently
  expire.
- **The trade-off:** you're routing traffic through Cloudflare, and DNS +
  TLS for this hostname now live in their control plane, not yours. If
  that's not acceptable for your setup, use the Caddy path instead.

## Prerequisites

- A domain already added to a Cloudflare account (the free tier is enough),
  with at least one subdomain you can point at this app.
- Root/`sudo` access over SSH to a **Debian 12** host -- LXC, VM, or bare
  metal. Same requirement as the native `artboard-ctl` path.
- Pineart already installed and running via `artboard-ctl install` (see
  `backend/README.md`), listening on `127.0.0.1:8000` / `127.0.0.1:4173`.

## Ordered command sequence (fresh server)

Run these from the same clone you used for `artboard-ctl install` (or a
fresh `git clone` if you're doing this after the fact):

```bash
# 1. App already running (backend/README.md's "Installing it for real").
sudo /tmp/bootstrap/backend/deploy/artboard-ctl install

# 2. Lock the host down BEFORE exposing anything. Must run first: the
#    tunnel needs no inbound port, so there's nothing for this step to
#    accidentally block, but doing it first means the box is never
#    briefly wide open while you're mid-setup.
sudo bash /tmp/bootstrap/deploy/firewall.sh

# 3. Copy and fill in the tunnel config.
cp /tmp/bootstrap/deploy/deploy.env.example /tmp/bootstrap/deploy/deploy.env
nano /tmp/bootstrap/deploy/deploy.env   # set ARTBOARD_PUBLIC_HOSTNAME at least

# 4. Install cloudflared, authenticate, create the tunnel, route DNS,
#    write config, install the systemd unit. Interactive once (tunnel
#    login opens a URL you approve in a browser); idempotent after that.
sudo bash /tmp/bootstrap/deploy/cloudflared/install-cloudflared.sh

# 5. Tell vite preview to accept the public hostname (see "Gotcha" below),
#    then restart it.
sudo nano /srv/artboard/shared/.env   # uncomment/set __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
sudo systemctl restart artboard-frontend
```

Day to day after this, deploys are just:

```bash
sudo artboard-ctl update
```

either by hand or via the `deploy.yml` GitHub Actions workflow below --
both run the identical command.

## Gotcha: vite's Host header check

`artboard-frontend.service` runs `vite preview`, which rejects any `Host`
header it doesn't recognize by default (DNS-rebinding protection).
`localhost` and bare IPs are allowed automatically; your real public
hostname is not. `backend/deploy/artboard-ctl` already writes a commented-out
line for this in `/srv/artboard/shared/.env`
(`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`) -- uncomment it, set it to your
`ARTBOARD_PUBLIC_HOSTNAME`, and restart `artboard-frontend`, or every
request through the tunnel gets a 403.

## Architecture

```
                         Cloudflare edge
                    (TLS termination, public DNS)
                              |
                              |  outbound-only connection,
                              |  initiated BY this host
                              |
   ┌──────────────────────────────────────────────────────┐
   │  Debian 12 host (LXC/VM)                              │
   │                                                        │
   │   ufw: deny all inbound except SSH (deploy/firewall.sh)│
   │                                                        │
   │   ┌────────────────────┐                              │
   │   │ artboard-tunnel.svc│  cloudflared, dedicated user, │
   │   │ (cloudflared)      │  no listening socket          │
   │   └─────────┬──────────┘                              │
   │              │ http://127.0.0.1:4173                   │
   │              v                                          │
   │   ┌────────────────────┐   /api/*   ┌─────────────────┐│
   │   │ artboard-frontend  │───────────>│ artboard.service││
   │   │ (vite preview,     │            │ (uvicorn,       ││
   │   │  127.0.0.1:4173)   │            │  127.0.0.1:8000)││
   │   └────────────────────┘            └─────────────────┘│
   │                                                        │
   │   /srv/artboard/current -> releases/<latest>  (symlink,│
   │   swapped atomically by artboard-ctl update)           │
   └──────────────────────────────────────────────────────┘
```

Only one public hostname is needed: the frontend already proxies `/api` to
the backend itself (`frontend/vite.config.ts`'s `preview.proxy`), so the
tunnel's ingress only ever points at port 4173. If a future service needs
its own public hostname (the way Curodav exposes its webapp and its
Radicale/DAV service separately), give it its own `hostname:`/`service:`
pair in `cloudflared/config.yml.template` -- don't route two different URL
layouts through one hostname.

## Verification

```bash
# End to end, from any machine with internet access:
curl -I https://<your-hostname>/api/health

# From the server itself, confirm each hop:
curl -sS http://127.0.0.1:8000/api/health          # backend directly
curl -sS http://127.0.0.1:4173/                    # frontend directly
sudo systemctl status artboard-tunnel              # tunnel connected?

# Tail logs while testing (one per terminal, or -f in the background):
sudo journalctl -u artboard-tunnel -f       # cloudflared connection/routing
sudo journalctl -u artboard-frontend -f     # 403s from the Host check land here
sudo journalctl -u artboard -f              # backend errors
sudo ufw status verbose                     # confirm only SSH is allowed in
```

A 403 from the frontend log while the tunnel itself shows "connected" is
almost always the vite Host-header gotcha above, not a tunnel problem.

## Files in this directory

| File | Purpose |
| --- | --- |
| `firewall.sh` | ufw lockdown: deny all inbound except SSH, explicit deny on the app's own ports. Run first. |
| `deploy.env.example` | Template for the hostname/tunnel-name/port variables the scripts below need. Copy to `deploy.env` (gitignored). |
| `cloudflared/install-cloudflared.sh` | Installs `cloudflared`, authenticates, creates/reuses the tunnel, routes DNS, renders config, installs the hardened systemd unit. Idempotent. |
| `cloudflared/config.yml.template` | Ingress rules template: public hostname -> local port, plus the required 404 catch-all. |
| `cloudflared/artboard-tunnel.service.template` | Hardened systemd unit for `cloudflared` -- dedicated user, no write access outside its own config dir. |
| `../.github/workflows/deploy.yml` | Thin CI trigger: SSHes in on push to `main` and runs `artboard-ctl update`. No deploy logic lives here. |

Not in this directory, but part of the same deployment: `backend/deploy/artboard-ctl`
(the install/update/remove script itself) and `backend/deploy/Caddyfile.example`
(the alternative reverse-proxy path, if you don't want a Cloudflare
dependency).
