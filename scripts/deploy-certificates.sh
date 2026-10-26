#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test "$(id -u)" = 0 || { echo 'Run as root on the new host' >&2; exit 1; }
# Compose resolves .env without evaluating it as shell code.
domain=$(docker compose --profile maintenance config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["nginx"]["environment"]["DOMAIN"])')
data_root=$(docker compose --profile maintenance config --format json | python3 -c 'import json,sys; print(next(v["source"] for v in json.load(sys.stdin)["services"]["certbot"]["volumes"] if v["target"]=="/etc/letsencrypt"))' )
case "${1:-}" in
  issue)
    ACME_EMAIL=${ACME_EMAIL:-$(docker compose --profile maintenance config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["certbot"]["environment"].get("ACME_EMAIL", ""))')}
    : "${ACME_EMAIL:?Set ACME_EMAIL in .env or the command environment}"
    docker compose stop nginx || true
    docker run -d --rm --name torrentduck-acme -p 80:80 \
      -v "$(pwd)/deploy/nginx/bootstrap.conf:/etc/nginx/conf.d/default.conf:ro" \
      -v "${data_root%/certificates}/acme:/var/www/acme:ro" nginx:stable-bookworm >/dev/null
    trap 'docker stop torrentduck-acme >/dev/null 2>&1 || true' EXIT INT TERM
    docker compose --profile maintenance run --rm certbot certonly --webroot -w /var/www/acme \
      --non-interactive --agree-tos --email "$ACME_EMAIL" -d "$domain"
    docker stop torrentduck-acme >/dev/null
    trap - EXIT INT TERM
    ;;
  renew)
    # The systemd timer already randomizes renewal times.
    docker compose --profile maintenance run --rm certbot renew --cert-name "$domain" --no-random-sleep-on-renew --webroot -w /var/www/acme --quiet
    ;;
  *) echo 'Usage: sudo sh scripts/deploy-certificates.sh issue | renew (set ACME_EMAIL in .env)' >&2; exit 1 ;;
esac
install -d -m 700 "${data_root%/certificates}/ftp-tls"
temporary="${data_root%/certificates}/ftp-tls/pure-ftpd.pem.new"
umask 077
cat "$data_root/live/$domain/fullchain.pem" "$data_root/live/$domain/privkey.pem" > "$temporary"
openssl x509 -in "$temporary" -checkend 86400 -noout >/dev/null
openssl pkey -in "$temporary" -check -noout >/dev/null
if test "$1" = renew && cmp -s "$temporary" "${temporary%.new}" && test ! -e "${data_root%/certificates}/ftp-tls/.reload-pending"; then
  rm "$temporary"
  exit 0
fi
touch "${data_root%/certificates}/ftp-tls/.reload-pending"
mv "$temporary" "${temporary%.new}"
docker compose up -d nginx ftp
docker compose exec -T nginx nginx -t
docker compose exec -T nginx nginx -s reload
# The FTPS server loads its certificate on process startup.
docker compose restart ftp
rm "${data_root%/certificates}/ftp-tls/.reload-pending"
