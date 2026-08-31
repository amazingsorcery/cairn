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
# NO SECRETS ARE ACCEPTED OR BAKED IN. There is no ARG or ENV here that carries a
# credential, and no `--mount=type=secret` is required, because the build does not talk to
# the database or to any authenticated service. Every secret is supplied at *runtime* via
# env_file. If a future build step ever needs a token, use BuildKit secret mounts
# (`RUN --mount=type=secret,id=...`) and never an ARG — ARG values are visible in
# `docker history`.

# ---------------------------------------------------------------------------------------
# base
# ---------------------------------------------------------------------------------------
# bookworm-slim rather than alpine: the app links against native modules (pg, esbuild via
# tsx, sharp if it is ever added) and glibc avoids a whole class of musl-only bugs. It is
# ~40 MB larger and worth it for something that must run unattended for months.
#
# NOTE ON PINNING: this is pinned to the major line only. Pin a digest before you consider
# the deployment stable — see docs/deploy/HANDOFF.md for the exact command to resolve one.
FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    # Corepack must not stop a non-interactive build to ask about downloading pnpm.
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1

# corepack ships with Node 22. `corepack enable` makes the `pnpm` shim available; the shim
# then reads the "packageManager" field in package.json and materialises exactly that
# version (pnpm@11.1.3), so the container and CI cannot drift from the lockfile's producer.
RUN corepack enable

WORKDIR /app


# ---------------------------------------------------------------------------------------
# deps — the cache-critical stage
# ---------------------------------------------------------------------------------------
# Only the manifests are copied here. Application source changes therefore do NOT
# invalidate this layer, and a normal code-only deploy skips the install entirely.
FROM base AS deps

# pnpm-workspace.yaml is copied because pnpm reads it at install time (it carries the
# build-script allowlist). It is absent from many single-package repos; the wildcard-free
# explicit copy would fail if it did not exist, so it is listed after the required files
# and this repo does have it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# --frozen-lockfile: fail the build rather than silently resolve a different tree.
# Dev dependencies ARE installed here — the build needs typescript, tailwind and eslint,
# and the migrator stage needs tsx. None of this reaches the runner stage.
# The cache mount keeps the pnpm content-addressable store across builds without putting
# it in a layer.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile


# ---------------------------------------------------------------------------------------
# builder
# ---------------------------------------------------------------------------------------
FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NODE_ENV=production during the build gives production React, minification and the
# production Tailwind pass. It does not prune node_modules (that already happened above).
ENV NODE_ENV=production

RUN pnpm build

# ---- Standalone layout guard -----------------------------------------------------------
# `next build` only emits .next/standalone when next.config.ts sets `output: "standalone"`.
# If that setting is missing the build "succeeds" and the runner stage would then copy
# nothing and crash at start with an opaque MODULE_NOT_FOUND. Fail here instead, loudly.
#
# The second check matters just as much: Next.js places server.js at the *workspace root
# relative path* inside .next/standalone. In a monorepo (or any repo Next.js decides is a
# monorepo because of a pnpm-workspace.yaml above the app) the entrypoint lands at
# .next/standalone/<path/to/app>/server.js instead of .next/standalone/server.js.
# This repo has the app and pnpm-workspace.yaml at the same directory, so the flat layout
# is expected — but assert it rather than assume it, because the failure mode if this ever
# changes is a container that builds fine and will not boot.
RUN set -eu; \
    if [ ! -d .next/standalone ]; then \
      echo "FATAL: .next/standalone was not produced."; \
      echo "       next.config.ts must set: output: \"standalone\""; \
      echo "       See docs/deploy/HANDOFF.md, requirement #1."; \
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

# `COPY /app/public ./public` in the runner stage is a hard error when the directory does
# not exist ("no source files were specified"), and a Next.js app is not required to have
# one. Guaranteeing it exists here keeps the runner stage's COPY unconditional instead of
# making the image build depend on whether anyone has added a favicon yet.
RUN mkdir -p public


# ---------------------------------------------------------------------------------------
# migrator — one-shot image, never long-running
# ---------------------------------------------------------------------------------------
# `pnpm db:migrate` is `tsx db/migrate.ts`. tsx is a devDependency and is deliberately NOT
# in the runtime image, and Next.js's standalone tracer would not include db/migrate.ts
# either (nothing in the request path imports it). So migrations get their own image built
# from the same source, run with `docker compose run --rm migrate`, and thrown away.
#
# The whole source tree is copied because the Drizzle SQL migration folder location is
# owned by the backend engineer (db/migrations, drizzle/, or whatever drizzle.config.ts
# points at) and hard-coding a guess here would break the day it moves. This image is
# ephemeral and never exposed, so the extra size costs nothing at runtime.
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
    # The standalone server binds to localhost by default, which is unreachable from the
    # Caddy container. 0.0.0.0 is safe here precisely because docker-compose.prod.yml
    # publishes no port for this service — only Caddy is reachable from the internet.
    HOSTNAME=0.0.0.0

# The official node images already provide an unprivileged `node` user (uid/gid 1000).
# Reusing it is one less thing to get wrong than minting a new one, and it owns nothing
# outside /app.
WORKDIR /app

# --- Standalone output layout, and why each path is what it is -------------------------
#
#   .next/standalone/           -> server.js + a pruned node_modules + package.json.
#                                  This is the whole server. Copy it to /app.
#   .next/static/               -> hashed JS/CSS chunks. The tracer deliberately EXCLUDES
#                                  these from standalone because they are meant to be
#                                  served by a CDN. We have no CDN, so they must be placed
#                                  at /app/.next/static — i.e. *inside* the .next directory
#                                  that came from standalone. Getting this wrong yields a
#                                  page that renders HTML and then 404s every chunk.
#   public/                     -> also excluded from standalone for the same reason, and
#                                  also served by server.js from /app/public.
#
# Order matters: standalone first (it creates /app/.next), then static into it.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# The Next.js server writes to .next/cache at runtime (fetch cache, and the ISR cache if
# any route ever revalidates). Without a writable directory owned by the runtime user the
# server logs permission errors on every cache write.
RUN mkdir -p .next/cache && chown -R node:node .next/cache

USER node

EXPOSE 3000

# Uses the same /api/health contract Caddy and deploy.sh rely on (see HANDOFF.md #2).
# node -e rather than curl/wget: bookworm-slim ships neither, and Node 22 has global fetch,
# so this adds zero packages and zero attack surface. A non-2xx (which the endpoint returns
# when Postgres is unreachable) marks the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]


# ---------------------------------------------------------------------------------------
# worker — the long-running poller container (v2, ADR 0019)
# ---------------------------------------------------------------------------------------
# `FROM migrator`, so this is literally the same filesystem with a different CMD: the same
# source tree, the same node_modules (devDependencies included, because `tsx` is one), the
# same layers on disk. Adding this stage costs one metadata layer, not a second image.
#
# WHY NOT `FROM runner`, which is what "share the image with web" would suggest.
# The runner stage contains `.next/standalone`, which is a node_modules tree PRUNED BY THE
# NEXT.JS TRACER to the modules the request path imports. The poller entrypoint is not a
# route, nothing in the request path imports it, so neither it nor `tsx` survives the
# prune. A `worker` service pointed at the runner image would start, fail to resolve its
# own entrypoint, and restart-loop — and it would do so only in the container, never in
# development. The migrator stage already solved this exact problem for `db/migrate.ts`
# (see the comment above it) and the answer is the same one.
#
# WHAT THAT COSTS, stated plainly rather than hidden: this image carries the whole
# repository and the whole devDependency tree in a container that runs for months, where
# the runner image carries neither. That is more code present at runtime than `web` has.
# The compensating controls are on the `worker` service in docker-compose.prod.yml — no
# published port, no route from Caddy, no egress-less network peer that matters, non-root,
# all capabilities dropped. The tightening path, if this is ever judged too much surface,
# is to bundle the entrypoint with esbuild into a single file and run it on a bare
# `node:22-bookworm-slim`; that is a build-tooling change, not a redesign.
FROM migrator AS worker

# Health endpoint port. Bound inside the container only — docker-compose.prod.yml publishes
# nothing for this service and Caddy has no route to it. See docs/deploy/HANDOFF.md §14 for
# the endpoint contract this port has to satisfy.
ENV WORKER_HEALTH_PORT=9091

# Documentation only. `expose` does not publish, and neither does this: it records for a
# reader of `docker inspect` which port the healthcheck below is talking to.
EXPOSE 9091

# A poller that dies silently is worse than one that crashes loudly (see HANDOFF §14).
# This probe answers ONE question: is the poll loop still ticking? It deliberately does NOT
# fail when an upstream is down — product-brief §2b requires one bad upstream to disable its
# own layer and nothing else, so an unreachable source must leave this container healthy and
# show up on the connector board instead. Distinguishing those two is the endpoint's job;
# this line only reads the verdict.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||9091)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# `pnpm worker` does not exist in package.json yet. That is deliberate and it is recorded as
# a BLOCKING requirement in docs/deploy/HANDOFF.md §14 — the container will fail to start
# with "Command \"worker\" not found" until the backend engineer adds it, which is the loud
# failure this file wants rather than a container that starts and polls nothing.
CMD ["pnpm", "worker"]
