#!/usr/bin/env bash
# Production mode: everything runs in Docker Compose (images built from the current code).
# Usage: npm run up:prod
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "No .env found. Copy .env.example to .env and fill it in."; exit 1; }
set -a; . ./.env; set +a
: "${DATA_DIR:?set DATA_DIR in .env}"
mkdir -p "$DATA_DIR"

echo "==> Building the agent image"
docker compose --profile build build agent-image
echo "==> Building and starting api, worker, dashboard, postgres and proxy"
docker compose up -d --build --wait --wait-timeout 180

echo
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
echo
echo "Dashboard: http://localhost:3000   (login: DASHBOARD_PASSWORD from .env)"
echo "Logs:      docker compose logs -f worker      Stop: npm run down"
