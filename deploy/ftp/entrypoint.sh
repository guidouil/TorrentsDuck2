#!/bin/sh
set -eu
: "${INTERNAL_API_SECRET:?Missing INTERNAL_API_SECRET}"
: "${PUBLIC_IPV4:?Missing PUBLIC_IPV4}"
test -s /etc/ssl/private/pure-ftpd.pem
exec python3 /usr/local/bin/guardian.py
