#!/usr/bin/env bash
#
# Deploy a specific tagged release to this box. This is the single script
# that turns "update to v1.4.0" into one command instead of a manual
# checklist — see advance.md §3, "how do I trust `git pull` on a system with
# a real database and real files."
#
# Usage:
#   ./deploy.sh v1.4.0
#
# What it does, in order, and why each step is where it is:
#   1. git fetch, then checkout the *tag* given on the command line — never
#      `main` directly. An update is a deliberate "update to this version",
#      not silently picking up whatever commit happens to be newest.
#   2. Stop the service *before* backing up. A backup taken while the app is
#      still writing to `db.sqlite3` (WAL mode) can capture an inconsistent
#      mix of the main file and the WAL; stopping first means the file on
#      disk is already in its one, fully-checkpointed, consistent state, and
#      a plain recursive copy is enough.
#   3. Rebuild the backend venv and frontend bundle for the new tag's code.
#   4. Run Alembic migrations. Always after the backup above, never before —
#      the whole point of the backup is that "the migration went wrong" is a
#      non-event instead of a crisis, and that's only true if it already
#      exists by the time the migration runs.
#   5. Restart the service and poll /api/health until it answers or a
#      timeout is hit.
#
# What this script deliberately does NOT promise: rolling back a schema
# migration automatically. Alembic downgrades exist but aren't reliably safe
# for every migration shape this project could ever write. Rolling back
# *code* (checkout the previous tag, rerun this script) is easy and safe;
# the real rollback path for a bad migration is restoring the pre-update
# backup this script just took — which is exactly why that backup step is
# not optional and cannot be skipped with a flag.

set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "Usage: $0 <tag>   (e.g. $0 v1.4.0)" >&2
  exit 1
fi

# Overridable for local testing; the real defaults match artboard.service /
# artboard-purge.service in this same directory.
ARTBOARD_ROOT="${ARTBOARD_ROOT:-/opt/artboard}"
ARTBOARD_SERVICE="${ARTBOARD_SERVICE:-artboard}"
ARTBOARD_HEALTH_URL="${ARTBOARD_HEALTH_URL:-http://127.0.0.1:8000/api/health}"
BACKUP_ROOT="${ARTBOARD_ROOT}/backups"

cd "$ARTBOARD_ROOT"

echo "==> Fetching tags"
git fetch --tags --quiet

if ! git rev-parse "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "Tag '${TAG}' not found. Run 'git tag' to see what's available." >&2
  exit 1
fi

CURRENT_TAG="$(git describe --tags --exact-match 2>/dev/null || echo "unknown")"
echo "==> Current: ${CURRENT_TAG}   Target: ${TAG}"

echo "==> Stopping ${ARTBOARD_SERVICE}"
sudo systemctl stop "${ARTBOARD_SERVICE}"

echo "==> Backing up data/ (service is stopped, so this is a consistent snapshot)"
mkdir -p "$BACKUP_ROOT"
BACKUP_PATH="${BACKUP_ROOT}/data-pre-${TAG}-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "${ARTBOARD_ROOT}/data" "$BACKUP_PATH"
echo "    backup: ${BACKUP_PATH}"

echo "==> Checking out ${TAG}"
git checkout --quiet "$TAG"

echo "==> Installing backend dependencies"
cd "${ARTBOARD_ROOT}/backend"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt
# requirements-dev.txt (pytest etc.) deliberately not installed on a
# production box — this script builds what runs, not what's tested with.

echo "==> Running database migrations"
.venv/bin/alembic upgrade head

echo "==> Building frontend"
cd "${ARTBOARD_ROOT}/frontend"
npm ci --silent
npm run build --silent

echo "==> Restarting ${ARTBOARD_SERVICE}"
sudo systemctl start "${ARTBOARD_SERVICE}"

echo "==> Waiting for /api/health"
ATTEMPTS=30
until curl --silent --fail "$ARTBOARD_HEALTH_URL" >/dev/null; do
  ATTEMPTS=$((ATTEMPTS - 1))
  if [[ "$ATTEMPTS" -le 0 ]]; then
    echo "!! ${ARTBOARD_SERVICE} did not become healthy in time." >&2
    echo "!! Code rollback: git checkout ${CURRENT_TAG} && rerun this script." >&2
    echo "!! Data rollback (only if the migration itself is the problem): restore ${BACKUP_PATH} over data/." >&2
    exit 1
  fi
  sleep 2
done

echo "==> Deployed ${TAG} successfully."
echo "    Backup of the pre-update state: ${BACKUP_PATH}"
