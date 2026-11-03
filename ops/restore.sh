#!/usr/bin/env bash
set -Eeuo pipefail

: "${POSTGRES_DB:?Set POSTGRES_DB}"
: "${POSTGRES_USER:?Set POSTGRES_USER}"
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the private age identity file}"
backup="${1:?Usage: bash ops/restore.sh path/to/backup.dump.age}"

if [[ ! -r "$backup" || ! -r "$AGE_IDENTITY_FILE" ]]; then
  echo "Backup or age identity file is not readable." >&2
  exit 1
fi

echo "This overwrites objects in database '$POSTGRES_DB'. Stop the API and worker first."
read -r -p "Type RESTORE to continue: " confirmation
if [[ "$confirmation" != "RESTORE" ]]; then
  echo "Restore cancelled."
  exit 1
fi

age --decrypt --identity "$AGE_IDENTITY_FILE" "$backup" \
  | docker compose exec -T db \
      pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error \
        --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" -
