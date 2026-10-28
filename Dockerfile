FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG ORIGIN
RUN npm run build

FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
RUN groupadd --gid 10000 duck && useradd --uid 10000 --gid duck --no-create-home duck
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM runtime AS studio
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/src/lib ./src/lib
COPY --from=build /app/scripts ./scripts
USER 10000:10000
CMD ["node", "--import", "tsx", "scripts/studio-worker.ts"]

FROM runtime AS web
COPY --from=build /app/build ./build
COPY --from=build /app/db ./db
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src/lib/server/db.ts /app/src/lib/server/passwords.ts ./src/lib/server/
USER 10000:10000
EXPOSE 3000
CMD ["node", "build"]
