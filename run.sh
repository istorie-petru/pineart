#!/usr/bin/env bash
#
# Artboard — one command to prepare the environment and run the app.
#
#   ./run.sh              start backend + frontend for development
#   ./run.sh --prod       build the frontend once and serve that, no dev server
#   ./run.sh --seed       ... and fill an empty database with demo content
#   ./run.sh --discovery  ... and start SearXNG so Discovery works
#   ./run.sh --skip-auth  ... and skip the login/setup screen entirely (plain
#                          dev mode only -- see below)
#   ./run.sh --docker     run the Docker Compose stack instead
#   ./run.sh --shell      open a subshell with the backend venv activated
#   ./run.sh --test       run the backend test suite and the frontend build
#   ./run.sh --stop       stop the Docker Compose stack and any dev SearXNG
#
# --discovery combines with any run mode: on its own it adds a SearXNG
# container for the dev/prod servers, and with --docker it enables the Compose
# `discovery` profile.
#
# --skip-auth (2026-09-18, direct request: forgetting a locally-set dev
# password shouldn't lock you out) only ever applies to the plain, unadorned
# dev-server mode above -- it is not a recognized flag for --prod or --docker,
# both of which run this same backend the way a real deploy would. It works by
# exporting ARTBOARD_DEV_SKIP_AUTH=true for this one invocation only (never
# written to backend/.env), which the backend additionally refuses to honor
# unless ARTBOARD_SECURE_COOKIES is also unset/false -- see
# backend/app/config.py's Config.dev_skip_auth for the full safety story.
#
# The default mode runs `vite`, whose dev server pushes a hot-reload update
# over a websocket on every source change — and since this app registers no
# HMR boundary (`import.meta.hot.accept()`), Vite's documented fallback is a
# full page reload. That is desirable while actively editing the frontend and
# surprising the rest of the time. --prod instead builds once with `vite build`
# and serves the static result with `vite preview`: no watcher, no websocket,
# no reload until you explicitly rebuild.
#
# Everything it sets up is idempotent: run it on a clean checkout or on an
# existing one and it does only the work that is actually missing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
VENV="$BACKEND/.venv"
SEARXNG_DIR="$ROOT/searxng"
API_PORT="${ARTBOARD_API_PORT:-8000}"
WEB_PORT="${ARTBOARD_WEB_PORT:-5173}"
# Only used by the native dev mode. The Compose stack publishes no SearXNG port
# at all and reaches it over the internal network by service name instead.
SEARXNG_PORT="${ARTBOARD_SEARXNG_PORT:-8888}"
SEARXNG_CONTAINER="artboard-searxng-dev"

# --- output helpers -----------------------------------------------------------

if [ -t 1 ]; then
	BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
	YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
	BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

info() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s  !!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# Prefix a stream with a coloured label, line by line.
#
# `sed -u` matters here rather than being a nicety: without it sed block-buffers
# whenever its output is not a terminal (a log file, a pipe into `less`, CI), so
# server output arrives in 4KB bursts or, for a short-lived run, never at all.
# BusyBox sed has no -u, hence the probe and fallback.
if sed -u '' </dev/null >/dev/null 2>&1; then SED_UNBUFFERED=(sed -u); else SED_UNBUFFERED=(sed); fi
prefix_stream() { "${SED_UNBUFFERED[@]}" "s/^/$1[$2]$RESET /"; }

# --- prerequisite checks ------------------------------------------------------

require() {
	command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed. $2"
}

port_busy() {
	# Bash's /dev/tcp is used rather than ss/lsof so this works on a minimal
	# container that has neither installed.
	(exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3>&- && return 0
	return 1
}

check_python() {
	require python3 "Install Python 3.11 or newer."
	python3 - <<-'PY' || die "Python 3.11 or newer is required."
		import sys
		raise SystemExit(0 if sys.version_info >= (3, 11) else 1)
	PY
}

# --- environment setup --------------------------------------------------------

setup_backend() {
	check_python

	# The venv is probed by actually running one of its console scripts, not by
	# testing that the directory exists. A venv is not relocatable: each script in
	# bin/ carries the absolute path of the venv's interpreter in its shebang, so
	# a venv copied between machines — or created inside a container against a
	# path that does not exist outside it — leaves a directory that looks
	# complete but whose every entry point dies with "bad interpreter".
	#
	# bin/python alone is not a sufficient test. It is a symlink to the system
	# interpreter and keeps working at any path, which is exactly why a
	# relocated venv can pass a naive check and still fail on the first `pip` or
	# `alembic` call.
	if ! "$VENV/bin/pip" --version >/dev/null 2>&1; then
		if [ -d "$VENV" ]; then
			warn "The existing virtualenv is broken (its interpreter is gone). Recreating it."
			rm -rf "$VENV"
		fi
		info "Creating the backend virtualenv"
		python3 -m venv "$VENV"
	fi

	# Reinstall only when requirements are newer than the marker, so a normal
	# start does not pay for a dependency resolution it does not need.
	local marker="$VENV/.requirements-installed"
	if [ ! -f "$marker" ] || [ "$BACKEND/requirements-dev.txt" -nt "$marker" ] \
		|| [ "$BACKEND/requirements.txt" -nt "$marker" ]; then
		info "Installing backend dependencies"
		"$VENV/bin/pip" install --quiet --upgrade pip
		"$VENV/bin/pip" install --quiet -r "$BACKEND/requirements-dev.txt"
		touch "$marker"
	fi
	ok "Backend dependencies ready"

	if [ ! -f "$BACKEND/.env" ] && [ -f "$BACKEND/.env.example" ]; then
		cp "$BACKEND/.env.example" "$BACKEND/.env"
		ok "Created backend/.env from the example"
	fi

	info "Applying database migrations"
	(cd "$BACKEND" && "$VENV/bin/alembic" upgrade head >/dev/null)
	ok "Database is up to date"
}

setup_frontend() {
	require node "Install Node 20 or newer."
	require npm "Install npm (it ships with Node)."

	if [ ! -d "$FRONTEND/node_modules" ] || [ "$FRONTEND/package.json" -nt "$FRONTEND/node_modules" ]; then
		info "Installing frontend dependencies"
		(cd "$FRONTEND" && npm install --no-audit --no-fund --silent)
	fi
	ok "Frontend dependencies ready"
}

# --- SearXNG (the optional Discovery backend) ---------------------------------

require_docker() {
	require docker "Install Docker, or run without --discovery."
	docker info >/dev/null 2>&1 || die "Docker is installed but not reachable. Is the daemon running, and is your user in the 'docker' group?"
}

generate_secret() {
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex 32
	else
		# Python is already a hard prerequisite, and secrets.token_hex draws from
		# the same OS entropy source that openssl does.
		python3 -c 'import secrets; print(secrets.token_hex(32))'
	fi
}

# Materialise searxng/settings.yml from the tracked example and give it a real
# secret_key. SearXNG signs the tokens behind its bot-protection and image proxy
# with this key, so a placeholder shared by every checkout is equivalent to no
# key at all. The generated file is gitignored for the same reason backend/.env
# is: a secret that lands in version control has to be treated as burned.
#
# Everything here is written so that it keeps working after the SearXNG image has
# taken ownership of the file, which it does on every start. The file is rebuilt
# from the example and renamed into place rather than edited where it lies:
# renaming needs write permission on the *directory*, which stays ours, and none
# at all on the file, which may by then belong to a uid we have never heard of.
# Editing in place would need to own the file and would demand a sudo chown after
# every single run.
setup_searxng_config() {
	local conf="$SEARXNG_DIR/settings.yml"
	local example="$SEARXNG_DIR/settings.yml.example"
	local placeholder="CHANGE_ME_openssl_rand_hex_32"
	local key=""

	[ -f "$example" ] || die "Missing $example — cannot configure SearXNG."

	# The one thing that cannot be worked around. If the directory itself is not
	# ours we can neither create nor replace anything inside it. Older versions of
	# this script bind-mounted the whole directory, which let the container chown
	# it; recovering from that needs root exactly once.
	[ -w "$SEARXNG_DIR" ] || die "$SEARXNG_DIR is not writable by $(id -un) — a SearXNG container took ownership of it.
       Take it back once with: sudo chown -R \"\$(id -u):\$(id -g)\" '$SEARXNG_DIR'
       Later runs will not need this again: only the settings file is mounted now,
       so the directory stays yours."

	# Reuse the existing key if there is a real one, so restarts do not invalidate
	# the tokens SearXNG has already signed.
	if [ -r "$conf" ]; then
		key="$(sed -n 's/^[[:space:]]*secret_key:[[:space:]]*"\?\([^"]*\)"\?[[:space:]]*$/\1/p' "$conf" | head -1)"
	fi
	if [ -z "$key" ] || [ "$key" = "$placeholder" ]; then
		key="$(generate_secret)"
		info "Generating a SearXNG secret_key"
	fi

	local tmp
	tmp="$(mktemp "$SEARXNG_DIR/.settings.yml.XXXXXX")" || die "Cannot write to $SEARXNG_DIR."
	sed "s|$placeholder|$key|" "$example" >"$tmp"
	# 0644, not 0600: the container reads this as a different uid, so owner-only
	# would lock it out. On a single-user machine the exposure is other local
	# accounts, which is the price of sharing a file with a container that insists
	# on its own user.
	chmod 644 "$tmp"
	mv -f "$tmp" "$conf"
	ok "SearXNG config ready"
}

wait_for_searxng() {
	local attempts=0
	until curl -sf "http://127.0.0.1:$SEARXNG_PORT/healthz" >/dev/null 2>&1; do
		attempts=$((attempts + 1))
		if [ "$attempts" -gt 40 ]; then
			warn "SearXNG did not answer within 20s. Check: docker logs $SEARXNG_CONTAINER"
			return 1
		fi
		sleep 0.5
	done
	return 0
}

SEARXNG_STARTED="no"

start_searxng_dev() {
	require_docker
	setup_searxng_config

	if [ -n "$(docker ps -q -f "name=^${SEARXNG_CONTAINER}$")" ]; then
		ok "SearXNG is already running on http://127.0.0.1:$SEARXNG_PORT"
		return
	fi
	# A dead container of the same name would block the run below.
	docker rm -f "$SEARXNG_CONTAINER" >/dev/null 2>&1 || true

	port_busy "$SEARXNG_PORT" && die "Port $SEARXNG_PORT is already in use. Stop the other process, or set ARTBOARD_SEARXNG_PORT."

	info "Starting SearXNG on http://127.0.0.1:$SEARXNG_PORT"
	# Published on 127.0.0.1 explicitly rather than with a bare -p, which would
	# bind 0.0.0.0 and hand everyone on the LAN an open search proxy. The Compose
	# stack avoids the question entirely by publishing nothing and keeping
	# SearXNG on an internal network; the dev server has no such network to join,
	# so loopback is the closest equivalent.
	#
	# The single settings file is mounted, not the directory around it. The image
	# runs `chown -R` over /etc/searxng at startup, and with a directory mount
	# that chown lands on the host directory — after which nothing on the host can
	# write into it without root. Mounting one file keeps the blast radius to that
	# file, which this script replaces wholesale rather than edits.
	docker run -d --rm \
		--name "$SEARXNG_CONTAINER" \
		-p "127.0.0.1:$SEARXNG_PORT:8080" \
		-e "SEARXNG_BASE_URL=http://127.0.0.1:$SEARXNG_PORT/" \
		-v "$SEARXNG_DIR/settings.yml:/etc/searxng/settings.yml" \
		searxng/searxng:latest >/dev/null \
		|| die "Could not start SearXNG."
	SEARXNG_STARTED="yes"

	wait_for_searxng && ok "SearXNG is ready"
}

stop_searxng_dev() {
	if [ -n "$(docker ps -q -f "name=^${SEARXNG_CONTAINER}$" 2>/dev/null)" ]; then
		docker stop "$SEARXNG_CONTAINER" >/dev/null 2>&1 || true
	fi
}

# --- run modes ----------------------------------------------------------------

BACKEND_PID=""
FRONTEND_PID=""

shutdown() {
	trap - INT TERM EXIT
	printf '\n'
	info "Shutting down"
	# uvicorn --reload and vite both fork children, so the children are killed
	# first; killing only the parent leaves a process holding the port and the
	# next start fails with a confusing "address already in use".
	for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
		[ -n "$pid" ] || continue
		pkill -TERM -P "$pid" 2>/dev/null || true
		kill -TERM "$pid" 2>/dev/null || true
	done
	wait 2>/dev/null || true
	# Only stop what this invocation started, so a SearXNG left running on
	# purpose from an earlier session survives a ctrl-c here.
	[ "$SEARXNG_STARTED" = "yes" ] && stop_searxng_dev
	ok "Stopped"
}

wait_for_api() {
	local attempts=0
	until curl -sf "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; do
		attempts=$((attempts + 1))
		if [ "$attempts" -gt 60 ]; then
			warn "The backend did not become healthy within 30s — see the log above."
			return 1
		fi
		# If the process died, stop waiting for something that is never coming.
		if [ -n "$BACKEND_PID" ] && ! kill -0 "$BACKEND_PID" 2>/dev/null; then
			die "The backend exited during startup. Scroll up for the traceback."
		fi
		sleep 0.5
	done
	return 0
}

print_setup_token() {
	# On a fresh database the app has no password and prints a one-time token.
	# Surfacing it here saves digging through the log for it.
	local token
	token="$(grep -oE '^\s{4}[A-Za-z0-9_-]{20,}$' "$LOG_FILE" 2>/dev/null | tail -1 | tr -d ' ')" || true
	if [ -n "$token" ]; then
		printf '\n%sThis instance has no password yet.%s\n' "$BOLD" "$RESET"
		printf 'Open the app and paste this one-time setup token:\n\n    %s%s%s\n\n' \
			"$GREEN" "$token" "$RESET"
	fi
}

run_dev() {
	local seed="$1"
	local discovery="$2"
	local skip_auth="$3"

	port_busy "$API_PORT" && die "Port $API_PORT is already in use. Stop the other process, or set ARTBOARD_API_PORT."
	port_busy "$WEB_PORT" && die "Port $WEB_PORT is already in use. Stop the other process, or set ARTBOARD_WEB_PORT."

	setup_backend
	setup_frontend

	if [ "$discovery" = "yes" ]; then
		start_searxng_dev
		# Exported before the backend starts so it is inherited by uvicorn. This
		# is the fallback the app uses; a URL saved in Settings -> Discovery
		# takes precedence over it.
		export ARTBOARD_SEARXNG_URL="http://127.0.0.1:$SEARXNG_PORT"
	fi

	if [ "$skip_auth" = "yes" ]; then
		# One-shot for this invocation only -- never written to backend/.env.
		# The backend has its own independent safety net on top of this (see
		# backend/app/config.py's Config.dev_skip_auth), so this isn't the only
		# thing standing between this flag and a real deploy, just the first.
		export ARTBOARD_DEV_SKIP_AUTH=true
		warn "--skip-auth: the login/setup screen is disabled for this run. Do not use this for anything but a local, throwaway instance."
	fi

	LOG_FILE="$BACKEND/.dev-backend.log"
	: >"$LOG_FILE"

	trap shutdown INT TERM EXIT

	info "Starting the backend on http://127.0.0.1:$API_PORT"
	(
		cd "$BACKEND"
		# PYTHONUNBUFFERED because Python switches to block buffering when stdout
		# is a pipe — which it always is here, since the stream is teed to a log
		# so the setup token can be pulled out of it. Without this, tracebacks
		# appear minutes late or not at all.
		export PYTHONUNBUFFERED=1
		# Bound to loopback deliberately: this is the development server and the
		# app ships no TLS of its own. Put it behind the reverse proxy in
		# backend/deploy/ to expose it.
		exec "$VENV/bin/uvicorn" app.main:app --reload --host 127.0.0.1 --port "$API_PORT"
	) > >(tee -a "$LOG_FILE" | prefix_stream "$BLUE" api) 2>&1 &
	BACKEND_PID=$!

	wait_for_api || true
	print_setup_token

	if [ "$seed" = "yes" ]; then
		info "Seeding demo content"
		(cd "$BACKEND" && "$VENV/bin/python" scripts/seed_demo.py "http://127.0.0.1:$API_PORT") \
			|| warn "Seeding failed — the app is still running."
	fi

	info "Starting the frontend on http://localhost:$WEB_PORT"
	(cd "$FRONTEND" && exec npm run dev -- --port "$WEB_PORT" --strictPort) \
		> >(prefix_stream "$GREEN" web) 2>&1 &
	FRONTEND_PID=$!

	printf '\n%sArtboard is running.%s  Open %shttp://localhost:%s%s   %s(ctrl-c to stop)%s\n' \
		"$BOLD" "$RESET" "$BOLD" "$WEB_PORT" "$RESET" "$DIM" "$RESET"

	if [ "$discovery" = "yes" ]; then
		# The proxy also checks a `discovery.enabled` flag that lives in the
		# database, which this script has no authenticated way to set. Saying so
		# is better than letting Discovery look broken.
		printf '%sSearXNG is up. Turn Discovery on in Settings -> Discovery to use it.%s\n' \
			"$DIM" "$RESET"
	fi
	printf '\n'

	# Exit as soon as either process does, so a crashed backend does not leave a
	# frontend running against nothing.
	wait -n "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}

run_prod() {
	local seed="$1"
	local discovery="$2"

	port_busy "$API_PORT" && die "Port $API_PORT is already in use. Stop the other process, or set ARTBOARD_API_PORT."
	port_busy "$WEB_PORT" && die "Port $WEB_PORT is already in use. Stop the other process, or set ARTBOARD_WEB_PORT."

	setup_backend
	setup_frontend

	if [ "$discovery" = "yes" ]; then
		start_searxng_dev
		export ARTBOARD_SEARXNG_URL="http://127.0.0.1:$SEARXNG_PORT"
	fi

	info "Building the frontend"
	(cd "$FRONTEND" && npm run build)
	ok "Frontend built"

	LOG_FILE="$BACKEND/.dev-backend.log"
	: >"$LOG_FILE"

	trap shutdown INT TERM EXIT

	info "Starting the backend on http://127.0.0.1:$API_PORT"
	(
		cd "$BACKEND"
		export PYTHONUNBUFFERED=1
		# No --reload: that flag restarts the API on every source change, which is
		# exactly the kind of "something changed, so something restarted" behaviour
		# --prod exists to avoid. Bound to loopback for the same reason as run_dev —
		# this ships no TLS of its own.
		exec "$VENV/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$API_PORT"
	) > >(tee -a "$LOG_FILE" | prefix_stream "$BLUE" api) 2>&1 &
	BACKEND_PID=$!

	wait_for_api || true
	print_setup_token

	if [ "$seed" = "yes" ]; then
		info "Seeding demo content"
		(cd "$BACKEND" && "$VENV/bin/python" scripts/seed_demo.py "http://127.0.0.1:$API_PORT") \
			|| warn "Seeding failed — the app is still running."
	fi

	info "Serving the production build on http://localhost:$WEB_PORT"
	# `vite preview` serves frontend/dist as static files and proxies /api to the
	# backend exactly like the dev server does (see vite.config.ts's `preview`
	# block) — but there is no file watcher and no HMR client, so nothing ever
	# pushes an unsolicited reload into an open tab.
	(cd "$FRONTEND" && exec npm run preview -- --port "$WEB_PORT" --strictPort) \
		> >(prefix_stream "$GREEN" web) 2>&1 &
	FRONTEND_PID=$!

	printf '\n%sArtboard is running (production build).%s  Open %shttp://localhost:%s%s   %s(ctrl-c to stop)%s\n' \
		"$BOLD" "$RESET" "$BOLD" "$WEB_PORT" "$RESET" "$DIM" "$RESET"
	printf '%sThis serves the build as of right now — re-run ./run.sh --prod after changing source files.%s\n' \
		"$DIM" "$RESET"
	if [ "$discovery" = "yes" ]; then
		printf '%sSearXNG is up. Turn Discovery on in Settings -> Discovery to use it.%s\n' "$DIM" "$RESET"
	fi
	printf '\n'

	wait -n "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}

run_docker() {
	local discovery="$1"

	require docker "Install Docker, or use ./run.sh without --docker."
	docker compose version >/dev/null 2>&1 || die "The 'docker compose' plugin is required."

	# An array rather than a string, so the two words stay two arguments instead
	# of being re-split by the shell.
	local -a profile=()
	if [ "$discovery" = "yes" ]; then
		setup_searxng_config
		profile=(--profile discovery)
	fi

	info "Building and starting the Compose stack"
	# ${a[@]+"${a[@]}"} rather than "${a[@]}": under `set -u`, expanding an empty
	# array is an unbound-variable error on bash before 4.4.
	(cd "$ROOT" && docker compose ${profile[@]+"${profile[@]}"} up -d --build)

	printf '\n%sArtboard is running%s at %shttp://localhost:8080%s\n' "$BOLD" "$RESET" "$BOLD" "$RESET"
	if [ "$discovery" = "yes" ]; then
		printf '%sSearXNG is up on the internal network. Turn Discovery on in Settings -> Discovery.%s\n' \
			"$DIM" "$RESET"
	fi
	printf 'Setup token (fresh database only):\n\n'
	(cd "$ROOT" && docker compose logs backend 2>/dev/null | grep -A2 'setup token' | tail -3) || true
	printf '\n%sStop with:%s ./run.sh --stop\n' "$DIM" "$RESET"
}

run_stop() {
	require docker "Install Docker — there is nothing for --stop to do without it."

	# --profile discovery is passed unconditionally. Compose ignores profiled
	# services on `down` unless their profile is named, so omitting it here would
	# tear down the stack while leaving an orphaned SearXNG container behind.
	info "Stopping the Compose stack"
	(cd "$ROOT" && docker compose --profile discovery down)
	stop_searxng_dev
	ok "Stopped"
}

run_tests() {
	setup_backend
	setup_frontend
	info "Running backend tests"
	(cd "$BACKEND" && "$VENV/bin/python" -m pytest tests -q)
	info "Typechecking and building the frontend"
	(cd "$FRONTEND" && npm run build)
	ok "All checks passed"
}

run_shell() {
	setup_backend
	info "Opening a subshell with the backend venv on PATH. Type 'exit' to leave."
	cd "$BACKEND"
	# A script cannot modify its parent shell, so this starts a child shell with
	# the venv activated rather than pretending to have activated yours.
	VIRTUAL_ENV="$VENV" PATH="$VENV/bin:$PATH" \
		exec "${SHELL:-/bin/bash}" -i
}

usage() {
	# Reprints the header comment block by structure rather than by line number,
	# so editing that block cannot silently truncate --help.
	awk 'NR == 1 { next } /^#/ { sub(/^#[[:space:]]?/, ""); print; next } { exit }' \
		"${BASH_SOURCE[0]}"
}

main() {
	local seed="no" discovery="no" mode="dev" skip_auth="no"

	# A loop rather than a single case, because --discovery is a modifier that has
	# to combine with whichever run mode is also given.
	while [ $# -gt 0 ]; do
		case "$1" in
			--seed)       seed="yes" ;;
			--discovery)  discovery="yes" ;;
			--skip-auth)  skip_auth="yes" ;;
			--prod)       mode="prod" ;;
			--docker)     mode="docker" ;;
			--stop)       mode="stop" ;;
			--test)       mode="test" ;;
			--shell)      mode="shell" ;;
			-h|--help)    mode="help" ;;
			*)            die "Unknown option: $1 (try --help)" ;;
		esac
		shift
	done

	# --skip-auth is deliberately only wired into run_dev below -- --prod and
	# --docker ignore $skip_auth entirely, both being "run this the way a real
	# deploy would" modes rather than throwaway dev servers.
	if [ "$skip_auth" = "yes" ] && [ "$mode" != "dev" ]; then
		die "--skip-auth only applies to plain dev mode (no --prod/--docker)."
	fi

	case "$mode" in
		dev)    run_dev "$seed" "$discovery" "$skip_auth" ;;
		prod)   run_prod "$seed" "$discovery" ;;
		docker) run_docker "$discovery" ;;
		stop)   run_stop ;;
		test)   run_tests ;;
		shell)  run_shell ;;
		help)   usage ;;
	esac
}

main "$@"
