#!/bin/sh
set -eu
: "${INTERNAL_API_SECRET:?Missing INTERNAL_API_SECRET}"
: "${PUBLIC_IPV4:?Missing PUBLIC_IPV4}"
test -s /etc/ssl/private/pure-ftpd.pem
mkdir -p /run/pure-ftpd
chmod 700 /run/pure-ftpd
exec python3 /usr/local/bin/guardian.py
