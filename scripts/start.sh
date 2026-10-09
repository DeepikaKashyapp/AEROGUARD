#!/usr/bin/env bash
# One command to run AEROGUARD on a laptop: installs dependencies on first run,
# builds the web app, seeds the SYNTHETIC demo course if there is no data yet,
# and serves everything from http://127.0.0.1:8000 (works offline afterwards).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
[ -d node_modules ] || npm install
npm run build -w web
[ -f "${AEROGUARD_DATA:-data}/aeroguard.db" ] || .venv/bin/python scripts/seed_demo.py
echo "AEROGUARD on http://${HOST:-127.0.0.1}:${PORT:-8000}"
exec .venv/bin/uvicorn server.api:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}"
