#!/usr/bin/env bash
# Merge Cloud Agent / shell environment variables into a dotenv file.
# Injected secrets win over values already in the file. Values are never logged.
set -euo pipefail

TARGET="${1:?usage: merge-runtime-secrets.sh <path-to-.env>}"

KEYS=(
  DATABASE_URL
  PORT
  REQUIRE_AUTH
  LEGACY_MONGO_URL
  LEGACY_MONGO_DB
  CHRONIK_XEC_URLS
  CHRONIK_DOGE_URLS
  VITE_API_URL
  VITE_BWS_URL
)

export MERGE_ENV_TARGET="$TARGET"
export MERGE_ENV_KEYS="${KEYS[*]}"

python3 <<'PY'
import os
from pathlib import Path

target = Path(os.environ["MERGE_ENV_TARGET"])
keys = os.environ.get("MERGE_ENV_KEYS", "").split()

lines = target.read_text(encoding="utf-8").splitlines() if target.exists() else []
entries: dict[str, str] = {}
trailing: list[str] = []

for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        trailing.append(line)
        continue
    if "=" not in line:
        trailing.append(line)
        continue
    name = line.split("=", 1)[0]
    entries[name] = line

for key in keys:
    value = os.environ.get(key)
    if value:
        entries[key] = f"{key}={value}"

body = "\n".join(entries.values())
suffix = ("\n" + "\n".join(trailing)) if trailing else ""
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(body + suffix + ("\n" if body else ""), encoding="utf-8")
PY
