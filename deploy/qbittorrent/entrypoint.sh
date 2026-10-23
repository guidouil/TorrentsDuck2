#!/bin/sh
set -eu
umask 022
python3 /usr/local/bin/initialize.py
exec qbittorrent-nox --confirm-legal-notice --webui-port=8080
