#!/usr/bin/env bash
# Idempotent local PostgreSQL setup for AbcPay v2 development.
# Starts a per-user Postgres 18 cluster listening on port 5433 with role/db "abcpay",
# matching DATABASE_URL in .env.example (postgresql://abcpay:abcpay@localhost:5433/abcpay).
set -euo pipefail

PG_BIN="$(ls -d /usr/lib/postgresql/18/bin /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
PGDATA="${PGDATA:-$HOME/.abcpay-pgdata}"
PG_PORT="${PG_PORT:-5433}"
PG_USER="abcpay"
PG_PASSWORD="abcpay"
PG_DB="abcpay"

export PATH="$PG_BIN:$PATH"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Initializing Postgres cluster at $PGDATA"
  mkdir -p "$PGDATA"
  PWFILE="$(mktemp)"
  printf '%s' "$PG_PASSWORD" > "$PWFILE"
  initdb -D "$PGDATA" -U "$PG_USER" --auth=trust --pwfile="$PWFILE" >/dev/null
  rm -f "$PWFILE"
fi

if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  echo "Starting Postgres on port $PG_PORT"
  pg_ctl -D "$PGDATA" -o "-p $PG_PORT -k /tmp" -l "$PGDATA/server.log" -w start
else
  echo "Postgres already running"
fi

# Wait for readiness.
for _ in $(seq 1 30); do
  if pg_isready -h localhost -p "$PG_PORT" -U "$PG_USER" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Ensure database exists (role is the initdb superuser, already present).
if ! psql -h localhost -p "$PG_PORT" -U "$PG_USER" -tAc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" postgres | grep -q 1; then
  echo "Creating database $PG_DB"
  createdb -h localhost -p "$PG_PORT" -U "$PG_USER" -O "$PG_USER" "$PG_DB"
fi

echo "Postgres ready: postgresql://$PG_USER:$PG_PASSWORD@localhost:$PG_PORT/$PG_DB"
