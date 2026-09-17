#!/usr/bin/env bash
# Per-boot startup for AbcPay v2: reconcile the local Postgres service and schema.
# Runs on every environment start; must be idempotent and terminate.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f .env ]; then
  cp .env.example .env
fi
# Keep the API copy current for terminals started in apps/abcpay-api.
cp .env apps/abcpay-api/.env

echo "==> Ensuring PostgreSQL is running"
bash scripts/setup-postgres.sh

echo "==> Applying database schema"
set -a; . ./.env; set +a
pnpm db:push

echo "==> Start reconciliation complete"
