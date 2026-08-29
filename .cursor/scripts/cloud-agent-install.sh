#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

export PATH="$HOME/.bun/bin:/usr/local/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

set -a
source .env
set +a

corepack enable
corepack prepare pnpm@9.10.0 --activate

pnpm install --frozen-lockfile
pnpm build

echo "AbcPay install complete"
