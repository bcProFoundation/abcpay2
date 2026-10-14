#!/usr/bin/env bash
# Idempotent Cloud Agent install for AbcPay v2.
# Prepares system deps (Node 26, PostgreSQL 18), workspace deps, shared package builds,
# a local Postgres cluster, and the database schema. Safe to run repeatedly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/cloud-env.sh
. "$REPO_ROOT/scripts/cloud-env.sh"

ensure_node_26() {
  if command -v node >/dev/null 2>&1 && node -v 2>/dev/null | grep -qE '^v26\.'; then
    echo "Node $(node -v) already on PATH"
    return 0
  fi

  NODE26_PREFIX="${NODE26_PREFIX:-$HOME/.local/node-26}"
  if [ -x "$NODE26_PREFIX/bin/node" ] && "$NODE26_PREFIX/bin/node" -v 2>/dev/null | grep -qE '^v26\.'; then
    export PATH="$NODE26_PREFIX/bin:$PATH"
    echo "Node $($NODE26_PREFIX/bin/node -v) already installed at $NODE26_PREFIX"
    return 0
  fi

  echo "==> Installing Node.js 26 (official binary)"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils

  local arch tarball expected tmpdir
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  tmpdir="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt" -o "$tmpdir/SHASUMS256.txt"
  tarball="$(awk -v a="$arch" '$2 ~ ("^node-v26\\.[0-9]+\\.[0-9]+-linux-" a "\\.tar\\.xz$") { print $2; exit }' "$tmpdir/SHASUMS256.txt")"
  expected="$(awk -v name="$tarball" '$2 == name { print $1; exit }' "$tmpdir/SHASUMS256.txt")"
  if [ -z "$tarball" ] || [ -z "$expected" ]; then
    echo "Could not resolve latest Node.js 26 linux-${arch} tarball" >&2
    exit 1
  fi
  curl -fsSL "https://nodejs.org/dist/latest-v26.x/${tarball}" -o "$tmpdir/${tarball}"
  echo "${expected}  ${tmpdir}/${tarball}" | sha256sum -c -
  mkdir -p "$NODE26_PREFIX"
  tar -xJf "$tmpdir/${tarball}" -C "$NODE26_PREFIX" --strip-components=1
  rm -rf "$tmpdir"
  export PATH="$NODE26_PREFIX/bin:$PATH"
  hash -r
}

echo "==> Ensuring Node.js 26 is available"
ensure_node_26
node -v
npm -v

echo "==> Ensuring pnpm 9.10.0 via corepack"
corepack enable
corepack prepare pnpm@9.10.0 --activate
pnpm -v

echo "==> Ensuring PostgreSQL 18 is installed"
if ! command -v psql >/dev/null 2>&1 || ! psql --version 2>/dev/null | grep -q ' 18\.'; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates gnupg lsb-release
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
bash scripts/merge-runtime-secrets.sh .env
# Copy .env for API processes started from apps/abcpay-api (tsx does not auto-load env files).
cp .env apps/abcpay-api/.env
if [ -n "${VITE_API_URL:-}" ] || [ -n "${VITE_BWS_URL:-}" ]; then
  bash scripts/merge-runtime-secrets.sh apps/abcpay-web/.env.local
fi

echo "==> Installing workspace dependencies"
pnpm install --frozen-lockfile

echo "==> Building shared packages"
pnpm build

echo "==> Starting local PostgreSQL and creating database"
bash scripts/setup-postgres.sh

echo "==> Pushing database schema"
set -a; . ./.env; set +a
apply_abcpay_schema

echo "==> Install complete"
