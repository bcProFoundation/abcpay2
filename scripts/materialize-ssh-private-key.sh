#!/usr/bin/env bash
# Write an OpenSSH private key from an environment variable to a file (mode 600).
# Cloud Agent secrets are often pasted as a single line; ssh/sshpass need a normal PEM.
#
# Usage:
#   eval "$(bash scripts/materialize-ssh-private-key.sh ABCPAY_PROD_SSH_KEY)"
#   ssh -i "$ABCPAY_SSH_PRIVATE_KEY_FILE" user@host
#
# Or print path only:
#   KEY=$(bash scripts/materialize-ssh-private-key.sh ABCPAY_PROD_SSH_KEY --print-path)
set -euo pipefail

VAR_NAME="${1:?usage: materialize-ssh-private-key.sh <ENV_VAR_NAME> [--print-path]}"
PRINT_PATH=0
if [ "${2:-}" = "--print-path" ]; then
  PRINT_PATH=1
fi

eval "raw=\${$VAR_NAME:-}"
if [ -z "$raw" ]; then
  echo "environment variable $VAR_NAME is unset" >&2
  exit 1
fi

CACHE_DIR="${ABCPAY_SSH_KEY_CACHE_DIR:-$HOME/.cache/abcpay}"
mkdir -p "$CACHE_DIR"
chmod 700 "$CACHE_DIR"
OUT="${ABCPAY_SSH_PRIVATE_KEY_FILE:-$CACHE_DIR/${VAR_NAME}.pem}"

export MATERIALIZE_RAW_KEY="$raw"
python3 <<'PY' >"$OUT"
import os
import re
import textwrap

raw = os.environ["MATERIALIZE_RAW_KEY"].strip()


def normalize_openssh_pem(s: str) -> str:
    if "-----BEGIN OPENSSH PRIVATE KEY-----" not in s:
        return s
    if s.count("\n") > 3 and "-----END OPENSSH PRIVATE KEY-----" in s:
        return s if s.endswith("\n") else s + "\n"
    begin = "-----BEGIN OPENSSH PRIVATE KEY-----"
    end = "-----END OPENSSH PRIVATE KEY-----"
    pattern = re.compile(
        re.escape(begin) + r"\s*(.+?)\s*" + re.escape(end), re.DOTALL
    )
    m = pattern.search(s.replace("\n", " "))
    if not m:
        raise SystemExit("could not parse OpenSSH private key markers")
    body = re.sub(r"\s+", "", m.group(1))
    if not body:
        raise SystemExit("empty OpenSSH key body")
    lines = textwrap.wrap(body, 64)
    return begin + "\n" + "\n".join(lines) + "\n" + end + "\n"


pem = normalize_openssh_pem(raw)
print(pem, end="")
PY

chmod 600 "$OUT"
unset MATERIALIZE_RAW_KEY

if ! ssh-keygen -y -f "$OUT" >/dev/null 2>&1; then
  rm -f "$OUT"
  echo "$VAR_NAME is present but ssh-keygen rejected the materialized key" >&2
  exit 1
fi

if [ "$PRINT_PATH" -eq 1 ]; then
  printf '%s\n' "$OUT"
else
  printf 'export ABCPAY_SSH_PRIVATE_KEY_FILE=%q\n' "$OUT"
fi