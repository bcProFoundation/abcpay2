#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

export PATH="$HOME/.bun/bin:/usr/local/bin:$PATH"

dc() {
  if docker compose "$@" 2>/dev/null; then
    return 0
  fi
  sudo docker compose "$@"
}

ensure_docker() {
  if docker info >/dev/null 2>&1 || sudo docker info >/dev/null 2>&1; then
    return 0
  fi

  sudo mkdir -p /etc/docker
  if [[ ! -f /etc/docker/daemon.json ]]; then
    echo '{"storage-driver":"vfs"}' | sudo tee /etc/docker/daemon.json >/dev/null
  fi

  sudo dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 45); do
    if docker info >/dev/null 2>&1 || sudo docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Docker daemon failed to start; see /tmp/dockerd.log" >&2
  return 1
}

ensure_docker
dc up -d

for _ in $(seq 1 45); do
  if dc exec -T postgres pg_isready -U abcpay >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

set -a
source .env
set +a

pnpm db:push

echo "AbcPay services ready (Postgres on :5433)"
