#!/usr/bin/env bash
# SSH to production using ABCPAY_PROD_SSH_KEY (single-line env secret OK).
# Intended for Cloud Agent env bcProFoundation/abcpay2 (333c6ba4).
#
# Optional env: ABCPAY_PROD_SSH_HOST, ABCPAY_PROD_SSH_USER, ABCPAY_PROD_SSH_PORT
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${ABCPAY_PROD_SSH_KEY:-}" ]; then
  echo "ABCPAY_PROD_SSH_KEY is unset (use Cloud Agent environment 333c6ba4)" >&2
  exit 1
fi

# shellcheck source=/dev/null
eval "$("$ROOT/scripts/materialize-ssh-private-key.sh" ABCPAY_PROD_SSH_KEY)"
export ABCPAY_PROD_SSH_KEY_FILE="$ABCPAY_SSH_PRIVATE_KEY_FILE"

HOST="${ABCPAY_PROD_SSH_HOST:-}"
USER="${ABCPAY_PROD_SSH_USER:-}"
PORT="${ABCPAY_PROD_SSH_PORT:-22}"

if [ -z "$HOST" ] || [ -z "$USER" ]; then
  echo "set ABCPAY_PROD_SSH_HOST and ABCPAY_PROD_SSH_USER (or pass ssh args after --)" >&2
  exit 1
fi

if [ "${1:-}" = "--" ]; then
  shift
  exec ssh -i "$ABCPAY_PROD_SSH_KEY_FILE" -p "$PORT" -o BatchMode=yes "$USER@$HOST" "$@"
fi

exec ssh -i "$ABCPAY_PROD_SSH_KEY_FILE" -p "$PORT" -o BatchMode=yes "$USER@$HOST"