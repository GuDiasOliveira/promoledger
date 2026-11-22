#!/usr/bin/env bash
# Regenerate the typed API client contract from the FastAPI app (no running server needed).
# Contract SSOT stays in the backend; the frontend fails to type-check if it drifts.
set -euo pipefail
FRONTEND="$(cd "$(dirname "$0")/.." && pwd)"
cd "$FRONTEND/../backend"
uv run python -c "import json; from app.main import app; print(json.dumps(app.openapi(), indent=2, sort_keys=True))" \
  > "$FRONTEND/lib/api/openapi.json"
cd "$FRONTEND"
npx openapi-typescript lib/api/openapi.json -o lib/api/schema.d.ts
