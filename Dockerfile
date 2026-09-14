# ── Build ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 compiles natively
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .

# The About block quotes the commit it was built from — the fastest answer
# to "did my update actually land". .dockerignore keeps .git out, so the
# value has to be handed in.
ARG BUILD_SHA=""
ENV BUILD_SHA=$BUILD_SHA
RUN npm run build

RUN npm prune --omit=dev

# ── Runtime ───────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      sqlite3 age ca-certificates git rclone && rm -rf /var/lib/apt/lists/*

# Dependencies live only at the root: npm with workspaces hoists them
# there, and server/node_modules does not exist at all. Node still finds
# them by walking up the tree from server/dist.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY scripts ./scripts

ENV DATA_DIR=/data
ENV WEB_DIST=/app/web/dist
ENV PORT=8787
EXPOSE 8787

# No root: any hole in a dependency yields at most a regular user's
# rights, not the container owner's. The data directory is created in
# advance with the right owner; a mounted volume must belong to uid 1000 —
# on the host that is `chown -R 1000:1000` on the data directory.
RUN mkdir -p /data && chown node:node /data /app
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
