#!/usr/bin/env bash
# Postgres backup for the AbcPay database. Streams a custom-format dump from the
# abcpay-postgres container, verifies it with pg_restore, and prunes old rolling dumps.
#
# Usage:
#   scripts/pg-backup.sh            # rolling dump (pruned to KEEP newest)
#   scripts/pg-backup.sh baseline   # labelled dump, never pruned automatically
set -euo pipefail

CONTAINER="${CONTAINER:-abcpay-postgres}"
DB="${DB:-abcpay}"
DB_USER="${DB_USER:-abcpay}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/abcpay-backups}"
KEEP="${KEEP:-30}"
LABEL="${1:-rolling}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/${LABEL}-${STAMP}.dump"

echo "[$(date -u +%FT%TZ)] dumping $DB from $CONTAINER -> $FILE"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB" > "$FILE"

if ! docker exec -i "$CONTAINER" pg_restore -l < "$FILE" > /dev/null 2>"$FILE.verify"; then
  echo "[$(date -u +%FT%TZ)] VERIFY FAILED (see $FILE.verify)" >&2
  exit 1
fi
rm -f "$FILE.verify"
echo "[$(date -u +%FT%TZ)] ok ($(du -h "$FILE" | cut -f1))"

if [ "$LABEL" = "rolling" ]; then
  ls -1t "$BACKUP_DIR"/rolling-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
    echo "[$(date -u +%FT%TZ)] pruning $old"
    rm -f "$old"
  done
fi
