# SupOps — single-image build: API + Socket.IO + built SPA + SQLite, on one port.
#
# The backend runs .ts directly via tsx (no transpile step), so the runtime image
# keeps node_modules (incl. tsx) and the workspace source. The web app is built to
# apps/web/dist and served by the server. No local data or secrets are baked in --
# see .dockerignore; the container provisions its own on first run.

# ---- builder: install deps (native better-sqlite3) and build the SPA ----
FROM node:22-bookworm AS builder
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# Install with the full workspace manifest set so npm resolves every workspace.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npm run build --workspace=@supops/web

# ---- runtime: slim image, prebuilt native module copied from the builder ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production SERVE_WEB=1
# openssl for first-run secret generation in the entrypoint.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
# Backend source runs from .ts; migrations must be present (auto-applied on boot).
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/server ./apps/server
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

EXPOSE 3001
VOLUME ["/app/data"]
ENTRYPOINT ["./docker/entrypoint.sh"]
