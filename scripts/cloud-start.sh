#!/usr/bin/env bash
# Per-boot startup for AbcPay v2.
# Reconciles the local Postgres service + schema, then launches the API and web
# dev servers in the background. Idempotent: safe to run on every boot.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export PATH="$HOME/.bun/bin:$PATH"

if [ ! -f .env ]; then
  cp .env.example .env
fi
cp .env apps/abcpay-api/.env

echo "==> Ensuring PostgreSQL is running"
bash scripts/setup-postgres.sh

echo "==> Applying database schema"
set -a; . ./.env; set +a
pnpm db:push

port_in_use() {
  ss -ltn 2>/dev/null | grep -q ":$1 " || netstat -ltn 2>/dev/null | grep -q ":$1 "
}

start_bg() {
  local name="$1" port="$2" cmd="$3"
  if port_in_use "$port"; then
    echo "==> $name already running on :$port (skip)"
    return 0
  fi
  echo "==> Starting $name dev server on :$port"
  nohup bash -lc "cd '$REPO_ROOT'; export PATH=\"\$HOME/.bun/bin:\$PATH\"; set -a; . ./.env; set +a; exec $cmd" \
    > "/tmp/abcpay-$name.log" 2>&1 &
}

start_bg api 3232 "pnpm dev:api"
start_bg web 5173 "pnpm dev:web"

echo "==> Start complete (API: http://localhost:3232/bws/api, Web: http://localhost:5173)"
