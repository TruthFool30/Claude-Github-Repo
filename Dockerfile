# Hearth — self-hosted family organizer.
#   docker build -t hearth .
#   docker run -p 3000:3000 -v hearth-data:/app/data hearth
# Data (SQLite database + uploads) lives in /app/data — mount a volume there.

# ---- build: install everything, build the client ----
FROM node:22-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# ---- runtime: pruned production deps + server + built client only ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/hearth.db \
    UPLOAD_DIR=/app/data/uploads \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/node_modules node_modules
COPY server/src server/src
COPY shared shared
COPY --from=build /app/client/dist client/dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
