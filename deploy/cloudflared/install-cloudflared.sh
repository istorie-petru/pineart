#!/usr/bin/env bash
# deploy/cloudflared/install-cloudflared.sh -- expose Art Board (Pineart) to
# the internet via an outbound-only Cloudflare Tunnel. No inbound port, no
# reverse proxy, no certificates to renew: cloudflared dials out from this
# host to Cloudflare's edge, which terminates TLS and forwards to
# 127.0.0.1:<port> here.
#
# Run this AFTER deploy/firewall.sh (see that file for why) and AFTER
# backend/deploy/artboard-ctl install has the app itself running on
# 127.0.0.1:4173.
#
# Idempotent except for two genuinely interactive, one-time steps:
#   - `cloudflared tunnel login` (opens a URL you approve in a browser)
#   - nothing else prompts; re-running this script detects an existing
#     login, tunnel, DNS route, and systemd unit, and leaves them alone.
#
# Config: reads deploy/deploy.env (copy from deploy/deploy.env.example) if
# it sits next to this script's parent directory; falls back to environment
# variables of the same name; prompts for whatever is still unset.
set -euo pipefail

APP_NAME="artboard"
LOCAL_PORT="${ARTBOARD_TUNNEL_LOCAL_PORT:-4173}"
CLOUDFLARED_USER="cloudflared"
CONFIG_DIR="/etc/cloudflared"
CONFIG_FILE="${CONFIG_DIR}/config.yml"
UNIT_FILE="/etc/systemd/system/${APP_NAME}-tunnel.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../deploy.env"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}==>${NC} $*"; }
err()  { echo -e "${RED}==>${NC} $*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  err "install-cloudflared.sh must run as root (sudo)."
  exit 1
fi

# --- config: deploy.env, then env vars, then interactive prompts -----------
if [ -f "$ENV_FILE" ]; then
  log "Loading ${ENV_FILE}..."
  set -a; source "$ENV_FILE"; set +a
fi

TUNNEL_NAME="${ARTBOARD_TUNNEL_NAME:-${APP_NAME}}"

if [ -z "${ARTBOARD_PUBLIC_HOSTNAME:-}" ]; then
  read -r -p "Public hostname to route to this app (e.g. artboard.example.com): " ARTBOARD_PUBLIC_HOSTNAME
fi
if [ -z "$ARTBOARD_PUBLIC_HOSTNAME" ]; then
  err "A public hostname is required."
  exit 1
fi

log "Tunnel name:      ${TUNNEL_NAME}"
log "Public hostname:  ${ARTBOARD_PUBLIC_HOSTNAME}"
log "Local service:    http://127.0.0.1:${LOCAL_PORT}"

# --- install cloudflared from Cloudflare's apt repo -------------------------
if ! command -v cloudflared >/dev/null 2>&1; then
  log "Installing cloudflared from Cloudflare's apt repo..."
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs 2>/dev/null || echo bookworm) main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq
  apt-get install -y cloudflared
else
  log "cloudflared already installed ($(cloudflared --version 2>&1 | head -n1))."
fi

# --- dedicated system user, before we write anything it needs to read ------
if ! id -u "$CLOUDFLARED_USER" >/dev/null 2>&1; then
  log "Creating system user '${CLOUDFLARED_USER}'..."
  useradd --system --home-dir "$CONFIG_DIR" --shell /usr/sbin/nologin "$CLOUDFLARED_USER"
fi
install -d -o root -g "$CLOUDFLARED_USER" -m 0750 "$CONFIG_DIR"

# --- login: one-time, interactive, skipped if already authenticated --------
# `cloudflared tunnel login` writes cert.pem under $HOME/.cloudflared -- this
# script runs as root, so that is /root/.cloudflared. Later commands
# (`tunnel create`, `tunnel route dns`) read from the same place, which is
# why they all need to run as root too, not as the cloudflared system user.
CERT_FILE="/root/.cloudflared/cert.pem"
if [ -f "$CERT_FILE" ]; then
  log "Already authenticated (${CERT_FILE} exists) -- skipping 'tunnel login'."
else
  log "Not authenticated yet. Opening the Cloudflare login flow -- open the"
  log "printed URL in a browser and authorize the domain you want to use."
  cloudflared tunnel login
  if [ ! -f "$CERT_FILE" ]; then
    err "Login did not produce ${CERT_FILE}. Aborting."
    exit 1
  fi
fi

# --- tunnel: create if it doesn't already exist -----------------------------
TUNNEL_ID="$(cloudflared tunnel list -o json 2>/dev/null \
  | grep -o "\"id\":\"[a-f0-9-]*\",\"name\":\"${TUNNEL_NAME}\"" \
  | head -n1 | grep -o '"id":"[a-f0-9-]*"' | cut -d'"' -f4 || true)"

if [ -z "$TUNNEL_ID" ]; then
  log "Creating tunnel '${TUNNEL_NAME}'..."
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID="$(cloudflared tunnel list -o json 2>/dev/null \
    | grep -o "\"id\":\"[a-f0-9-]*\",\"name\":\"${TUNNEL_NAME}\"" \
    | head -n1 | grep -o '"id":"[a-f0-9-]*"' | cut -d'"' -f4)"
else
  log "Tunnel '${TUNNEL_NAME}' already exists (id ${TUNNEL_ID}), reusing it."
fi

if [ -z "$TUNNEL_ID" ]; then
  err "Could not determine the tunnel ID for '${TUNNEL_NAME}'."
  exit 1
fi

# --- credentials: move out of /root, into the config dir the service reads -
SRC_CRED_FILE="/root/.cloudflared/${TUNNEL_ID}.json"
CRED_FILE="${CONFIG_DIR}/${TUNNEL_NAME}-credentials.json"
if [ ! -f "$CRED_FILE" ]; then
  if [ ! -f "$SRC_CRED_FILE" ]; then
    err "Expected credentials at ${SRC_CRED_FILE} but they're not there."
    err "This happens if the tunnel was created earlier from a different"
    err "account/home dir. Re-run 'cloudflared tunnel create ${TUNNEL_NAME}'"
    err "manually, or delete the tunnel and let this script recreate it."
    exit 1
  fi
  log "Installing tunnel credentials to ${CRED_FILE}..."
  install -o root -g "$CLOUDFLARED_USER" -m 0440 "$SRC_CRED_FILE" "$CRED_FILE"
else
  log "Credentials already present at ${CRED_FILE}, leaving them untouched."
fi

# --- DNS route: idempotent, cloudflared no-ops if it already points here ---
log "Routing ${ARTBOARD_PUBLIC_HOSTNAME} -> tunnel '${TUNNEL_NAME}'..."
if ! cloudflared tunnel route dns "$TUNNEL_NAME" "$ARTBOARD_PUBLIC_HOSTNAME" 2>&1 \
  | tee /tmp/cloudflared-route-dns.log; then
  if grep -qi "already exists\|already configured" /tmp/cloudflared-route-dns.log; then
    warn "DNS route already exists for ${ARTBOARD_PUBLIC_HOSTNAME}, continuing."
  else
    err "Failed to create DNS route. See output above."
    exit 1
  fi
fi
rm -f /tmp/cloudflared-route-dns.log

# --- render config.yml from the template ------------------------------------
log "Writing ${CONFIG_FILE}..."
sed \
  -e "s|__TUNNEL_ID__|${TUNNEL_ID}|g" \
  -e "s|__CRED_FILE__|${CRED_FILE}|g" \
  -e "s|__PUBLIC_HOSTNAME__|${ARTBOARD_PUBLIC_HOSTNAME}|g" \
  -e "s|__LOCAL_PORT__|${LOCAL_PORT}|g" \
  "${SCRIPT_DIR}/config.yml.template" > "$CONFIG_FILE"
chown root:"$CLOUDFLARED_USER" "$CONFIG_FILE"
chmod 0440 "$CONFIG_FILE"

# --- systemd unit: our own hardened unit, not `cloudflared service install` -
log "Writing ${UNIT_FILE}..."
cp "${SCRIPT_DIR}/artboard-tunnel.service.template" "$UNIT_FILE"
systemctl daemon-reload
systemctl enable --now "${APP_NAME}-tunnel.service"
systemctl restart "${APP_NAME}-tunnel.service"

log "Waiting for the tunnel to connect..."
sleep 3
systemctl --no-pager status "${APP_NAME}-tunnel.service" || true

log "Done. https://${ARTBOARD_PUBLIC_HOSTNAME} should now reach"
log "127.0.0.1:${LOCAL_PORT} on this host through Cloudflare's edge."

# vite preview (artboard-frontend.service) rejects any Host header it
# doesn't recognize by default -- without this, every request through the
# tunnel gets a 403 no matter how correctly the tunnel itself is configured.
# artboard-ctl set-hostname is the one-line fix (sets
# __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS in shared/.env and restarts the
# service) -- do it here automatically rather than leaving it as a step
# someone has to remember and know vite.config.ts even exists for.
if command -v artboard-ctl >/dev/null 2>&1; then
  log "Allowing '${ARTBOARD_PUBLIC_HOSTNAME}' through vite preview's Host check..."
  artboard-ctl set-hostname "$ARTBOARD_PUBLIC_HOSTNAME"
else
  warn "artboard-ctl not found on PATH -- has 'artboard-ctl install' been run yet?"
  warn "Without it, vite preview will 403 every request through this tunnel."
  warn "Once it's installed, run: sudo artboard-ctl set-hostname ${ARTBOARD_PUBLIC_HOSTNAME}"
fi
