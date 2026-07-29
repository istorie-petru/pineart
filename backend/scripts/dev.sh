#!/usr/bin/env bash
# Local development server: applies migrations, then runs uvicorn with reload.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d .venv ]; then
	python3 -m venv .venv
	./.venv/bin/pip install -r requirements-dev.txt
fi

./.venv/bin/alembic upgrade head
exec ./.venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
