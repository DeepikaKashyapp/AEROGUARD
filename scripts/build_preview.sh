#!/usr/bin/env bash
# Build the static, server-free preview: the real sim and console run in the
# browser; scoring, debriefs and dashboards are recorded from the SYNTHETIC demo
# course. Output: build/preview/aeroguard-preview.html (one self-contained file).
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-.venv/bin/python}
[ -f "${AEROGUARD_DATA:-data}/aeroguard.db" ] || "$PY" scripts/seed_demo.py
"$PY" scripts/snapshot_preview.py build/preview/snapshot.json
(cd web && VITE_DEMO=1 npx vite build --outDir ../build/preview/dist --emptyOutDir)
"$PY" scripts/inline_preview.py build/preview/dist build/preview/aeroguard-preview.html
