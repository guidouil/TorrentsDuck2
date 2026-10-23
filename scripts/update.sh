#!/bin/sh
set -eu
cd /opt/torrentduck
test "$(id -u)" != 0 || { echo 'Run this script as the deployment user, without sudo.' >&2; exit 1; }
exec 9>.git/deploy.lock
flock -n 9 || { echo 'Another deployment is already running.' >&2; exit 1; }
changes=$(git status --porcelain)
if test -n "$changes"; then
  echo 'Local changes found. Commit or resolve them before deploying.' >&2
  exit 1
fi
git pull --ff-only

sudo sh -s <<'ROOT'
set -eu
cleanup() {
  docker image prune -f --filter label=com.docker.compose.project=torrentduck
  docker builder prune -af --keep-storage 1GB
}
trap 'result=$?; trap - EXIT; cleanup; exit "$result"' EXIT
cleanup
docker_root=$(docker info --format '{{.DockerRootDir}}')
set -- $(df -Pk "$docker_root" | awk 'NR == 2 {print $2, $4}')
if test "$#" != 2 || test "$2" -lt "$(($1 / 10 + 5242880))"; then
  echo 'Not enough Docker disk space: keep 10% free plus 5 GiB for the build.' >&2
  exit 1
fi
sh scripts/deploy.sh
# Render the bind-mounted Nginx template even when its image has not changed.
docker compose up -d --no-deps --force-recreate --wait nginx
docker compose exec -T web node --input-type=module - <<'JS'
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch(process.env.ORIGIN + '/api/health', { signal: AbortSignal.timeout(3000) });
    if (response.ok && (await response.json()).status === 'ok') process.exit(0);
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
throw new Error('Public HTTPS health check failed');
JS
echo 'Deployment complete; public HTTPS health check passed.'
ROOT
