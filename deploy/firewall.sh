#!/bin/sh
# Install before Docker starts; its DOCKER-USER chain survives daemon restarts.
set -eu
test "$(id -u)" = 0 || { echo 'Run as root on the Docker host' >&2; exit 1; }
command -v iptables >/dev/null
iptables -N DOCKER-USER 2>/dev/null || true
iptables -nL DOCKER-USER >/dev/null
modprobe br_netfilter
sysctl -q -w net.bridge.bridge-nf-call-iptables=1
iptables -N DUCK-QBT 2>/dev/null || true
for source in 172.30.20.2 172.30.40.2; do
  # Temporary deny prevents a permissive interval while rebuilding the chain.
  iptables -I DOCKER-USER 1 -s "$source" -j DROP
  iptables -C INPUT -s "$source" -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP 2>/dev/null || iptables -I INPUT 1 -s "$source" -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP
  while iptables -C INPUT -s "$source" -j DROP 2>/dev/null; do
    iptables -D INPUT -s "$source" -j DROP
  done
done
iptables -F DUCK-QBT
iptables -A DUCK-QBT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for destination in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A DUCK-QBT -d "$destination" -j DROP
done
iptables -A DUCK-QBT -j RETURN
for source in 172.30.20.2 172.30.40.2; do
  iptables -C DOCKER-USER -s "$source" -j DUCK-QBT 2>/dev/null || iptables -I DOCKER-USER 2 -s "$source" -j DUCK-QBT
  iptables -D DOCKER-USER -s "$source" -j DROP
done
