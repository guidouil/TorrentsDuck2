FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3-pyftpdlib python3-openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10000 duck && useradd --uid 10000 --gid duck --home-dir /data --no-create-home duck \
    && mkdir /data
COPY auth.py server.py /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/entrypoint
COPY guardian.py /usr/local/bin/guardian.py
ENTRYPOINT ["sh", "/usr/local/bin/entrypoint"]
