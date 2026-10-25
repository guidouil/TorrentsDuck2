#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test "$(id -u)" = 0 || { echo 'Run as root on the Ubuntu host' >&2; exit 1; }
test -s .env || { echo 'Create .env from .env.example first' >&2; exit 1; }
chmod 600 .env
docker compose config -q
for unit in torrentduck.service torrentduck-firewall.service torrentduck-certificates.service torrentduck-certificates.timer torrentduck-backup.service torrentduck-backup.timer; do
  install -m 644 "deploy/systemd/$unit" "/etc/systemd/system/$unit"
done
install -D -m 644 deploy/systemd/docker.service.d/torrentduck-firewall.conf /etc/systemd/system/docker.service.d/torrentduck-firewall.conf
systemctl daemon-reload
sh deploy/firewall.sh
systemctl enable --now torrentduck-firewall.service
docker compose build --pull
docker compose up -d --wait postgres
docker compose run --rm --no-deps --entrypoint node web --import tsx scripts/migrate-db.ts
docker compose up -d --wait
systemctl enable --now torrentduck.service torrentduck-certificates.timer torrentduck-backup.timer
echo 'Stack started. Finish the acceptance checks in docs/deployment.md before opening registrations.'
