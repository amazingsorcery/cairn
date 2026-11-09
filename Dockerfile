# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the Next.js 15 App Router application.
#
#   base     -> pinned Node 22 + corepack-managed pnpm, shared by every stage
#   deps     -> node_modules only (the expensive, rarely-invalidated layer)
#   builder  -> `pnpm build` producing .next/standalone
#   migrator -> one-shot image for `pnpm db:migrate` / `pnpm db:seed` (needs devDeps: tsx)
#   runner   -> final runtime image: slim, non-root, production-only files
#
# Build targets:
#   docker build --target runner   -t app-web:current    .
#   docker build --target migrator -t app-migrate:current .
#
# No secrets are baked in; they arrive at runtime via env_file. If a build step ever needs
# a token, use `RUN --mount=type=secret`, never ARG (visible in `docker history`).

# ---------------------------------------------------------------------------------------
# base
# ---------------------------------------------------------------------------------------
# bookworm-slim rather than alpine: glibc avoids musl issues with native modules.
# Pinned to the major line only; pin a digest for a stable deployment
# (`docker buildx imagetools inspect node:22-bookworm-slim`).
FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    # Shared path so the cache prepared as root is readable by USER node later.
    COREPACK_HOME=/usr/local/corepack \
    NEXT_TELEMETRY_DISABLED=1

# Prepare pnpm at build time: the migrate container runs on an internal network with no
# internet, so the corepack shim can't download pnpm on first use there.
RUN corepack enable \
    && corepack prepare pnpm@11.1.3 --activate \
    && chmod -R a+rX /usr/local/corepack

WORKDIR /app


# ---------------------------------------------------------------------------------------
# deps — the cache-critical stage
# ---------------------------------------------------------------------------------------
# Manifests only, so source changes don't invalidate the install layer.
FROM base AS deps

# pnpm-workspace.yaml holds the build-script allowlist read at install time.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Includes devDependencies (build tooling, tsx for the migrator); not copied to runner.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile


# ---------------------------------------------------------------------------------------
# builder
# ---------------------------------------------------------------------------------------
FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production

RUN pnpm build

# ---- Standalone layout guard -----------------------------------------------------------
# Fail here if `output: "standalone"` is missing, or if Next.js nested server.js under a
# workspace subpath; otherwise the runner image builds but won't boot.
RUN set -eu; \
    if [ ! -d .next/standalone ]; then \
      echo "FATAL: .next/standalone was not produced."; \
      echo "       next.config.ts must set: output: \"standalone\""; \
      exit 1; \
    fi; \
    if [ ! -f .next/standalone/server.js ]; then \
      echo "FATAL: .next/standalone/server.js is missing. Next.js nested the standalone"; \
      echo "       output under a workspace subpath. Found instead:"; \
      find .next/standalone -maxdepth 3 -name server.js -print; \
      echo "       Fix the COPY paths in the runner stage to match, or set"; \
      echo "       outputFileTracingRoot in next.config.ts."; \
      exit 1; \
    fi; \
    echo "OK: standalone entrypoint at .next/standalone/server.js"

# The runner's COPY of public/ fails if the directory doesn't exist.
RUN mkdir -p public


# ---------------------------------------------------------------------------------------
# migrator — one-shot image, never long-running
# ---------------------------------------------------------------------------------------
# `pnpm db:migrate` runs tsx, which isn't in the runtime image, so migrations get their
# own image (`docker compose run --rm migrate`). Copies the full tree; it's ephemeral.
FROM base AS migrator

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

USER node

# Overridable: `docker compose run --rm migrate pnpm db:seed`
CMD ["pnpm", "db:migrate"]


# ---------------------------------------------------------------------------------------
# runner — the only image that ships
# ---------------------------------------------------------------------------------------
FROM base AS runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    # Needed so Caddy can reach it; the port is not published (only Caddy is public).
    HOSTNAME=0.0.0.0

WORKDIR /app

# Standalone excludes .next/static and public/ (meant for a CDN); server.js serves them
# from these paths. Standalone first, since it creates /app/.next.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Writable runtime cache (fetch/ISR) for the node user.
RUN mkdir -p .next/cache && chown -R node:node .next/cache

USER node

EXPOSE 3000

# Same /api/health endpoint Caddy and deploy.sh use; non-2xx when Postgres is down.
# node fetch because bookworm-slim has no curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
