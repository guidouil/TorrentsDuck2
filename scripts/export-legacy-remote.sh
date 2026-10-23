#!/bin/sh
# Executed over SSH, never installed on the legacy server. Stdout is tar only.
set -eu
umask 077
container=$1
database=$2
test -d /dev/shm
test "$(stat -f -c %T /dev/shm)" = tmpfs || { echo '/dev/shm must be a memory filesystem' >&2; exit 1; }
work=$(mktemp -d /dev/shm/torrentduck-export.XXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
docker exec "$container" mongo "$database" --quiet --eval '
var users = db.users.find({}, {_id:1,username:1,emails:1,createdAt:1,isAdmin:1,isValid:1,roles:1,allowed:1,"services.password.bcrypt":1}).toArray();
if (!users.length) { quit(4); }
print(JSON.stringify({users:users}));
' > "$work/users.json"
mkdir "$work/config"
for path in /etc/nginx/nginx.conf /etc/nginx/sites-available /opt/mup-nginx-proxy/config /etc/bind /etc/docker/daemon.json /etc/fstab /etc/ssh/sshd_config; do
  if test -e "$path"; then
    parent="$work/config$(dirname "$path")"
    mkdir -p "$parent"
    cp -a "$path" "$parent/" 2>/dev/null || echo "Optional configuration not fully readable: $path" >&2
  fi
done
docker ps --format '{{.Names}} {{.Image}}' > "$work/config/containers.txt"
docker inspect "$container" > "$work/config/mongodb-container.json"
uname -a > "$work/config/kernel.txt"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$work/exported-at.txt"
tar -C "$work" -cf - users.json config exported-at.txt
