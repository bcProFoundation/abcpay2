#!/usr/bin/env bash
# LAN test deployment for the Raspberry Pi: API + web served by Docker with a tiny
# static/proxy server. Postgres runs on the host (see scripts/setup-postgres.sh or the
# abcpay-postgres container created during migration).
#
# Usage (on the Pi):
#   REPO_DIR=$HOME/abcpay2-deploy bash scripts/lan-deploy.sh
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/abcpay2-deploy}"
PG_ENV="${PG_ENV:-$HOME/abcpay-pg.env}"
PI_IP="${PI_IP:-192.168.31.149}"
PG_PORT="${PG_PORT:-5433}"
NET=abcpay-net

if [ ! -d "$REPO_DIR/apps/abcpay-api" ]; then
  echo "repo not found at $REPO_DIR (clone the branch there first)" >&2
  exit 1
fi
if [ ! -f "$PG_ENV" ]; then
  echo "missing $PG_ENV with POSTGRES_PASSWORD" >&2
  exit 1
fi
if [ ! -f "$REPO_DIR/apps/abcpay-web/dist/index.html" ]; then
  echo "web build not found at $REPO_DIR/apps/abcpay-web/dist (scp the built dist)" >&2
  exit 1
fi

urlencode() {
  local string="$1" encoded="" char hex i
  for ((i = 0; i < ${#string}; i++)); do
    char="${string:i:1}"
    case "$char" in
      [a-zA-Z0-9.~_-]) encoded+="$char" ;;
      *)
        printf -v hex '%%%02X' "'$char"
        encoded+="$hex"
        ;;
    esac
  done
  printf '%s' "$encoded"
}

PG_PASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$PG_ENV")"
DATABASE_URL="postgresql://abcpay:$(urlencode "$PG_PASSWORD")@${PI_IP}:${PG_PORT}/abcpay"

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
docker rm -f abcpay-api abcpay-web >/dev/null 2>&1 || true

echo "==> starting API container"
docker run -d --name abcpay-api --restart unless-stopped --network "$NET" -p 3232:3232 \
  -v "$REPO_DIR":/app \
  -v abcpay-pnpm-store:/root/.local/share/pnpm/store \
  -w /app/apps/abcpay-api \
  -e DATABASE_URL="$DATABASE_URL" -e PORT=3232 -e REQUIRE_AUTH=1 \
  node:26-bookworm sh -c 'command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@9.10.0 --silent --no-fund --no-audit; cd /app && { [ -x apps/abcpay-api/node_modules/.bin/tsx ] || pnpm install --frozen-lockfile --ignore-scripts; } && cd apps/abcpay-api && exec ./node_modules/.bin/tsx src/index.ts'

echo "==> starting web container"
docker run -d --name abcpay-web --restart unless-stopped --network "$NET" -p 8080:8080 \
  -v "$REPO_DIR":/app -w /app \
  -e PORT=8080 -e WEB_DIST=/app/apps/abcpay-web/dist -e API_ORIGIN=http://abcpay-api:3232 \
  node:26-alpine node scripts/lan-web-server.js

echo "==> waiting for API health"
api_healthy=0
for i in $(seq 1 180); do
  if docker exec abcpay-api node -e "fetch('http://127.0.0.1:3232/bws/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    echo "api healthy after ${i}s"
    api_healthy=1
    break
  fi
  sleep 1
done
if [ "$api_healthy" -ne 1 ]; then
  echo "API did not become healthy; recent logs:" >&2
  docker logs --tail 50 abcpay-api >&2 || true
  exit 1
fi

docker ps --filter name=abcpay --format '{{.Names}} {{.Status}} {{.Ports}}'
echo "web:  http://${PI_IP}:8080"
echo "api:  http://${PI_IP}:3232/bws/api"
