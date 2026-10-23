FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends qbittorrent-nox python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10000 duck && useradd --uid 10000 --gid duck --no-create-home duck
COPY initialize.py /usr/local/bin/initialize.py
COPY entrypoint.sh /usr/local/bin/entrypoint
ENV HOME=/config XDG_CONFIG_HOME=/config XDG_DATA_HOME=/config/data XDG_CACHE_HOME=/tmp/cache
USER 10000:10000
ENTRYPOINT ["sh", "/usr/local/bin/entrypoint"]
