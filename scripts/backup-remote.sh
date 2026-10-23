#!/bin/sh
# Only logical data and configuration; torrent payloads are deliberately excluded.
set -eu
cd "$(dirname "$0")/.."
umask 077
test "$(stat -f -c %T /dev/shm)" = tmpfs || { echo '/dev/shm must be a memory filesystem' >&2; exit 1; }
work=$(mktemp -d /dev/shm/torrentduck-backup.XXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
docker compose exec -T postgres pg_dump --no-owner --no-acl --format=custom -U duck duck > "$work/database.dump"
mkdir "$work/config"
cp .env compose.yaml "$work/config/"
cp -a deploy "$work/config/"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$work/completed-at.txt"
tar -C "$work" -cf - database.dump config completed-at.txt
