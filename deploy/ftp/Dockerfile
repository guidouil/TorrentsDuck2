FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends pure-ftpd python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10000 duck && useradd --uid 10000 --gid duck --home-dir /data --no-create-home duck \
    && mkdir /data
COPY auth.py /usr/local/bin/ftp-auth
COPY entrypoint.sh /usr/local/bin/entrypoint
COPY guardian.py /usr/local/bin/guardian.py
RUN chmod 755 /usr/local/bin/ftp-auth
ENTRYPOINT ["sh", "/usr/local/bin/entrypoint"]
