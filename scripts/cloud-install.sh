#!/usr/bin/env bash
# Idempotent Cloud Agent install for AbcPay v2.
# Prepares system deps (Bun, PostgreSQL), workspace deps, shared package builds,
# a local Postgres cluster, and the database schema. Safe to run repeatedly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Ensuring Bun is installed"
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"
bun --version

echo "==> Ensuring PostgreSQL is installed"
if ! ls /usr/lib/postgresql/*/bin/postgres >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-contrib
fi

echo "==> Creating .env from .env.example (if missing)"
if [ ! -f .env ]; then
  cp .env.example .env
fi
# Bun auto-loads apps/abcpay-api/.env from its own working directory.
cp .env apps/abcpay-api/.env

echo "==> Installing workspace dependencies"
pnpm install --frozen-lockfile

echo "==> Building shared packages"
pnpm build

echo "==> Starting local PostgreSQL and creating database"
bash scripts/setup-postgres.sh

echo "==> Pushing database schema"
set -a; . ./.env; set +a
pnpm db:push

echo "==> Install complete"
