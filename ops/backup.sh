#!/usr/bin/env bash
set -Eeuo pipefail

: "${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT to the age public recipient}"
: "${POSTGRES_DB:?Set POSTGRES_DB}"
: "${POSTGRES_USER:?Set POSTGRES_USER}"
: "${BACKUP_DIR:?Set BACKUP_DIR to a protected host directory}"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="$BACKUP_DIR/eventreminder-$timestamp.dump.age"
temporary="$destination.partial"
trap 'rm -f "$temporary"' EXIT

docker compose exec -T db \
  pg_dump --format=custom --no-owner --no-acl \
    --username="$POSTGRES_USER" "$POSTGRES_DB" \
  | age --recipient "$BACKUP_AGE_RECIPIENT" --output "$temporary" -

mv "$temporary" "$destination"
find "$BACKUP_DIR" -type f -name 'eventreminder-*.dump.age' -mtime +30 -delete
printf 'Encrypted database backup written: %s\n' "$destination"
