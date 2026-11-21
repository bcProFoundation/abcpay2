#!/usr/bin/env bash
# Upgrade eCash Bitcoin ABC on abcpay.cash (Docker host; default 0.34.5).
# Requires: docker group or root. Run ON the prod VM (e.g. as devops).
#
# Usage:
#   CONTAINER_FILTER=8332 bash scripts/prod-upgrade-bitcoin-abc-0343.sh
#   # or
#   CONTAINER_ID=55a0755d8724 bash scripts/prod-upgrade-bitcoin-abc-0343.sh
#
# Env:
#   NEW_VERSION=0.34.5   (default)
#   DRY_RUN=1            (print plan only)
set -euo pipefail

NEW_VERSION="${NEW_VERSION:-0.34.5}"
XEC_DATA="${XEC_DATA:-/media/data/xecdata}"
CONF="${CONF:-$XEC_DATA/bitcoin.conf}"
CONTAINER_FILTER="${CONTAINER_FILTER:-8332}"
CONTAINER_ID="${CONTAINER_ID:-}"

log() { printf '==> %s\n' "$*"; }
need_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "docker not available (add user to docker group or run as root/devops)" >&2
    exit 1
  fi
}

need_docker

if [ -z "$CONTAINER_ID" ]; then
  CONTAINER_ID="$(docker ps --format '{{.ID}} {{.Ports}}' |
    awk -v f="$CONTAINER_FILTER" '$0 ~ f {print $1; exit}')"
fi
if [ -z "$CONTAINER_ID" ]; then
  echo "no running container matching filter '$CONTAINER_FILTER'" >&2
  exit 1
fi

log "container: $CONTAINER_ID"
IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_ID")"
NAME="$(docker inspect --format '{{.Name}}' "$CONTAINER_ID" | sed 's#^/##')"
log "image: $IMAGE"
log "name: $NAME"

BACKUP="$XEC_DATA/bitcoin.conf.bk.pre-${NEW_VERSION}-$(date +%F-%H%M)"
if [ ! -f "$CONF" ]; then
  echo "missing $CONF" >&2
  exit 1
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY_RUN: would backup to $BACKUP"
  log "DRY_RUN: would set chronikreindex=0 in $CONF if enabled"
  log "DRY_RUN: would stop container and recreate with $NEW_VERSION image"
  docker inspect "$CONTAINER_ID" --format 'Args={{json .Args}} Env={{json .Config.Env}} Mounts={{json .Mounts}} NetworkMode={{.HostConfig.NetworkMode}} PortBindings={{json .HostConfig.PortBindings}} RestartPolicy={{json .HostConfig.RestartPolicy}}'
  exit 0
fi

log "backing up bitcoin.conf"
cp -a "$CONF" "$BACKUP"
if grep -qE '^chronikreindex=1' "$CONF"; then
  log "setting chronikreindex=0 (avoid full Chronik reindex on upgrade)"
  sed -i.bk-chronik 's/^chronikreindex=1/chronikreindex=0/' "$CONF"
fi

log "graceful bitcoind stop"
docker exec "$CONTAINER_ID" bitcoin-cli \
  -conf=/usr/app/bitcoin/bitcoin.conf \
  -datadir=/usr/app/bitcoin/database \
  stop || true
for _ in $(seq 1 120); do
  docker exec "$CONTAINER_ID" pgrep -x bitcoind >/dev/null 2>&1 || break
  sleep 2
done
docker stop -t 120 "$CONTAINER_ID"

# Pull target image: custom devops tags often use 54_0.33.x — official 0.34.x is bitcoinabc/bitcoin-abc.
if [[ "$IMAGE" == *:* ]]; then
  REPO="${IMAGE%:*}"
  TARGET_IMAGE="${REPO}:${NEW_VERSION}"
else
  TARGET_IMAGE="bitcoinabc/bitcoin-abc:${NEW_VERSION}"
fi
log "pulling $TARGET_IMAGE"
if ! docker pull "$TARGET_IMAGE" 2>/dev/null; then
  ALT="${REPO}:54_${NEW_VERSION}"
  if docker pull "$ALT" 2>/dev/null; then
    TARGET_IMAGE="$ALT"
  else
    TARGET_IMAGE="bitcoinabc/bitcoin-abc:${NEW_VERSION}"
    log "fallback pull $TARGET_IMAGE"
    docker pull "$TARGET_IMAGE"
  fi
fi
OFFICIAL_IMAGE=0
[[ "$TARGET_IMAGE" == bitcoinabc/bitcoin-abc:* ]] && OFFICIAL_IMAGE=1

INSPECT_JSON="$(mktemp)"
docker inspect "$CONTAINER_ID" >"$INSPECT_JSON"
CONTAINER_USER="$(docker inspect --format '{{.Config.User}}' "$CONTAINER_ID" 2>/dev/null || true)"
docker rm "$CONTAINER_ID" || true

log "recreating container (same hostconfig as before)"
export INSPECT_JSON TARGET_IMAGE NAME CONTAINER_USER OFFICIAL_IMAGE
python3 - "$INSPECT_JSON" "$TARGET_IMAGE" "$NAME" <<'PY'
import json
import os
import subprocess
import sys

inspect_path, target_image, container_name = sys.argv[1:4]
official = os.environ.get("OFFICIAL_IMAGE") == "1"
run_user = (os.environ.get("CONTAINER_USER") or "").strip()

with open(inspect_path) as f:
    data = json.load(f)[0]
hc = data["HostConfig"]
cfg = data["Config"]

cmd = ["docker", "run", "-d", "--name", container_name]
if run_user:
    cmd += ["--user", run_user]
elif official:
    cmd += ["--user", "1000:1000"]

net = (hc.get("NetworkMode") or "").strip()
if net and net not in ("default", "bridge"):
    cmd += ["--network", net]
rp = hc.get("RestartPolicy") or {}
if rp.get("Name"):
    cmd += ["--restart", rp["Name"]]

for bind in hc.get("Binds") or []:
    cmd += ["-v", bind]
for port, specs in (hc.get("PortBindings") or {}).items():
    if specs:
        host = specs[0]["HostPort"]
        container_port = port.split("/")[0]
        cmd += ["-p", f"{host}:{container_port}"]

if official:
    cmd.append(target_image)
    cmd += [
        "bitcoind",
        "-conf=/usr/app/bitcoin/bitcoin.conf",
        "-datadir=/usr/app/bitcoin/database",
    ]
else:
    entry = cfg.get("Entrypoint")
    if entry:
        cmd += ["--entrypoint", entry[0] if isinstance(entry, list) else str(entry)]
    args = cfg.get("Cmd") or ["./start-bitcoind.sh"]
    cmd.append(target_image)
    cmd.extend(args if isinstance(args, list) else [args])

print("$", subprocess.list2cmdline(cmd))
subprocess.check_call(cmd)
PY

rm -f "$INSPECT_JSON"

log "waiting for v${NEW_VERSION} in debug.log (up to 10m)"
for _ in $(seq 1 120); do
  if grep -q "Bitcoin ABC version v${NEW_VERSION}" "$XEC_DATA/debug.log" 2>/dev/null; then
    grep 'Bitcoin ABC version' "$XEC_DATA/debug.log" | tail -1
    break
  fi
  sleep 5
done

log "RPC check (requires rpc credentials in bitcoin.conf)"
python3 <<'PY'
import json, re, urllib.request, base64
from pathlib import Path
conf = Path("/media/data/xecdata/bitcoin.conf").read_text()
u = re.search(r"^rpcuser=(.*)$", conf, re.M).group(1).strip()
p = re.search(r"^rpcpassword=(.*)$", conf, re.M).group(1).strip()
auth = base64.b64encode(f"{u}:{p}".encode()).decode()

def rpc(method):
    req = urllib.request.Request(
        "http://127.0.0.1:8332",
        data=json.dumps({"jsonrpc": "1.0", "id": "1", "method": method, "params": []}).encode(),
        headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["result"]

print("subversion:", rpc("getnetworkinfo")["subversion"])
print("blocks:", rpc("getblockchaininfo")["blocks"])
print("warnings:", rpc("getblockchaininfo").get("warnings"))
PY

log "done — monitor sync vs https://chronik.e.cash until heights match"