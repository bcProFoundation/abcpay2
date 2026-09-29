#!/usr/bin/env bash
# Prefer a local Node.js 26 install over the Cloud Agent image default (often Node 22).
# Sourced by cloud-install.sh, cloud-start.sh, and environment terminals.
NODE26_PREFIX="${NODE26_PREFIX:-$HOME/.local/node-26}"
if [ -x "$NODE26_PREFIX/bin/node" ]; then
  export PATH="$NODE26_PREFIX/bin:$PATH"
fi

# drizzle-kit push is not idempotent on this schema (UUID PKs). Skip once tables exist.
apply_abcpay_schema() {
  local port="${PG_PORT:-5433}"
  if psql -h localhost -p "$port" -U abcpay -d abcpay -tAc "SELECT to_regclass('public.wallets')" 2>/dev/null | grep -q wallets; then
    echo "Schema already present; skipping db:push"
    return 0
  fi
  pnpm db:push
}
