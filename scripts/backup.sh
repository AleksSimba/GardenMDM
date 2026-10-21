#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
file="backups/gardenmdm-$(date -u +%Y%m%dT%H%M%SZ).dump"
if [ -e "$file" ]; then printf 'Backup file already exists\n' >&2; exit 1; fi
trap 'rm -f "$file.partial"' EXIT HUP INT TERM
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$file.partial"
mv "$file.partial" "$file"
printf '%s\n' "$file"
