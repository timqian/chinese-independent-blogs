# Indi on a plain server: Node 22 + SQLite + SMTP, no Cloudflare.
# Build from the repository root:  docker build -t indi .
FROM node:22-bookworm-slim

WORKDIR /app

# Dependencies first, so editing the source doesn't reinstall them
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci --omit=dev --no-audit --no-fund

# The app reads the bundled blog list and the shared feed parser from the repo root
COPY blogs-original.csv ./
COPY scripts/lib ./scripts/lib
COPY frontend ./frontend

ENV NODE_ENV=production \
    DB_PATH=/data/indi.db \
    PORT=8787 \
    HOST=0.0.0.0

# SQLite database (and its WAL files) live on a volume
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/robots.txt').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

WORKDIR /app/frontend
# Migrations run on startup; configure through environment variables (see .env.example)
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
