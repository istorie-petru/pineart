#!/usr/bin/env bash
# deploy/firewall.sh -- lock the host down to SSH + the Cloudflare Tunnel's
# outbound-only connection, on a Debian 12 box with ufw.
#
# Run this BEFORE deploy/cloudflared/install-cloudflared.sh. Order matters:
# the tunnel needs no inbound port at all (it dials out to Cloudflare's
# edge), so there is nothing it needs opened here -- this script only ever
# needs to run once, and installing the tunnel afterwards can't get locked
# out by it.
#
# Belt-and-suspenders, deliberately: backend/deploy/artboard-ctl already
# binds both the backend (8000) and the frontend (4173) to 127.0.0.1 only,
# and the tunnel is the only intended path in. This script is the second
# layer on top of that -- if either service were ever accidentally bound to
# 0.0.0.0, ufw is what actually stops it from being reachable.
#
# Idempotent: every `ufw` call below is safe to re-run. `ufw allow`/`ufw deny`
# no-op if the rule already exists, and `ufw --force enable` on an
# already-enabled firewall just reloads the same rule set.
set -euo pipefail

APP_BACKEND_PORT=8000
APP_FRONTEND_PORT=4173
# Only relevant if 'artboard-ctl install --discovery' was used -- denying it
# here is harmless either way, since it's not listening at all otherwise.
APP_SEARXNG_PORT=8888
SSH_PORT=22

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
err()  { echo -e "${RED}==>${NC} $*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  err "deploy/firewall.sh must run as root (sudo)."
  exit 1
fi

if ! command -v ufw >/dev/null 2>&1; then
  log "Installing ufw..."
  apt-get update -qq
  apt-get install -y --no-install-recommends ufw
fi

log "Setting default policy: deny incoming, allow outgoing..."
ufw default deny incoming
ufw default allow outgoing

log "Allowing SSH (${SSH_PORT}/tcp) -- do this before enabling, or you will"
log "lock yourself out of this session."
ufw allow "${SSH_PORT}/tcp" comment "SSH"

log "Explicitly denying the app's own ports (${APP_BACKEND_PORT}, ${APP_FRONTEND_PORT}, ${APP_SEARXNG_PORT})..."
log "These are already bound to 127.0.0.1 by artboard-ctl and unreachable from"
log "the network regardless, and the tunnel needs no inbound port either --"
log "this rule exists as defense in depth, not as the primary control."
ufw deny "${APP_BACKEND_PORT}/tcp" comment "artboard backend -- loopback only, tunnel is the path in"
ufw deny "${APP_FRONTEND_PORT}/tcp" comment "artboard frontend -- loopback only, tunnel is the path in"
ufw deny "${APP_SEARXNG_PORT}/tcp" comment "artboard SearXNG (Discovery) -- loopback only, reached via the backend proxy"

log "Enabling ufw..."
ufw --force enable

log "Current rules:"
ufw status verbose
