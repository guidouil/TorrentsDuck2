FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY vite.config.ts tsconfig.json ./
COPY src ./src
COPY static ./static
COPY deploy/qbittorrent/search/catalog.json ./deploy/qbittorrent/search/catalog.json
ARG ORIGIN
RUN npm run build

FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
RUN groupadd --gid 10000 duck && useradd --uid 10000 --gid duck --no-create-home duck
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM runtime AS studio
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg fonts-dejavu-core python3-venv \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]==2026.10.26' \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*
COPY src/lib ./src/lib
COPY scripts ./scripts
USER 10000:10000
CMD ["node", "--import", "tsx", "scripts/studio-worker.ts"]

FROM runtime AS web
COPY --from=build /app/build ./build
COPY db ./db
COPY scripts ./scripts
COPY src/lib/server/db.ts src/lib/server/passwords.ts ./src/lib/server/
USER 10000:10000
EXPOSE 3000
CMD ["node", "build"]
