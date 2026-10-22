# Recall sync server: the built app plus the sync API, in one small image.
#   docker compose up -d --build        (see compose.yaml and docs/SYNC.md)

FROM node:22.20.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

FROM node:22.20.0-alpine
WORKDIR /app
ENV NODE_ENV=production \
    RECALL_HOST=0.0.0.0 \
    RECALL_PORT=8787 \
    RECALL_DATA_DIR=/data \
    RECALL_STATIC_DIR=/app/dist
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "dist-server/recall-server.mjs"]
CMD ["serve"]
