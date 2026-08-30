#!/usr/bin/env bash
# Idempotent Cloud Agent install for AbcPay v2.
# Prepares system deps (Bun 1.4.0, PostgreSQL 18), workspace deps, shared package builds,
# a local Postgres cluster, and the database schema. Safe to run repeatedly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUN_VERSION="${BUN_VERSION:-1.4.0}"

echo "==> Ensuring Bun ${BUN_VERSION} is installed"
export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1 || ! bun --version | grep -q "^${BUN_VERSION}"; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
fi
export PATH="$HOME/.bun/bin:$PATH"
bun --version

echo "==> Ensuring PostgreSQL 18 is installed"
if ! command -v psql >/dev/null 2>&1 || ! psql --version 2>/dev/null | grep -q ' 18\.'; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq curl ca-certificates gnupg lsb-release
  if [ ! -f /usr/share/keyrings/postgresql.gpg ]; then
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /usr/share/keyrings/postgresql.gpg
  fi
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
  echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
    | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-18 postgresql-client-18
fi
psql --version

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
