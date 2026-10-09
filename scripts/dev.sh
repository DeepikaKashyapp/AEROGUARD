#!/usr/bin/env bash
# Development: API with auto-reload on :8000 and the Vite dev server on :5173
# (which proxies /api to the API). Open http://127.0.0.1:5173.
set -euo pipefail
cd "$(dirname "$0")/.."
.venv/bin/uvicorn server.api:app --reload --port 8000 &
API=$!
trap 'kill $API' EXIT
npm run dev -w web
