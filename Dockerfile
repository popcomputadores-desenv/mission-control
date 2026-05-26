# syntax=docker/dockerfile:1.7
# ── Stage 0: extraer binario openclaw desde su imagen oficial ──
FROM ghcr.io/openclaw/openclaw:latest AS openclaw-bin

# ── Stage 1: deps ──────────────────────────────────────────────
FROM node:22.22.0-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS deps
# Copy only dependency manifests first for better layer caching
COPY package.json ./
COPY pnpm-lock.yaml* ./
COPY pnpm-workspace.yaml ./
# better-sqlite3 requires native compilation tools
RUN apt-get update && apt-get install -y python3 make g++ --no-install-recommends && rm -rf /var/lib/apt/lists/*
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile; \
    else \
      echo "WARN: pnpm-lock.yaml not found in build context; running non-frozen install" && \
      pnpm install --no-frozen-lockfile; \
    fi

# ── Stage 2: build ─────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# ─── PR-CANDIDATE: NEXT_PUBLIC_* baked into client bundle ──────────────────
# Next.js inlines NEXT_PUBLIC_* into the client JS at build time. Without
# these ARG/ENV pairs, downstream operators (Docker / CI / k8s) cannot
# configure the gateway URL for the browser without a custom image build.
# Discovered via Project EIGHTBALL deployment with separate subdomain for
# the gateway (openclaw-mac.example.io) vs dashboard (mc-mac.example.io).
ARG NEXT_PUBLIC_GATEWAY_URL=
ARG NEXT_PUBLIC_GATEWAY_HOST=
ARG NEXT_PUBLIC_GATEWAY_PORT=
ARG NEXT_PUBLIC_GATEWAY_PROTOCOL=
ARG NEXT_PUBLIC_GATEWAY_REVERSE_PROXY=
ARG NEXT_PUBLIC_GATEWAY_CLIENT_ID=
ARG NEXT_PUBLIC_GATEWAY_OPTIONAL=
ARG NEXT_PUBLIC_COORDINATOR_AGENT=
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
ARG GATEWAY_PROTOCOL_VERSION=
ARG GATEWAY_SCOPES=
ARG GATEWAY_CLIENT_ID=
ARG GATEWAY_DEVICE_AUTH_PAYLOAD=
ENV NEXT_PUBLIC_GATEWAY_URL=${NEXT_PUBLIC_GATEWAY_URL}
ENV NEXT_PUBLIC_GATEWAY_HOST=${NEXT_PUBLIC_GATEWAY_HOST}
ENV NEXT_PUBLIC_GATEWAY_PORT=${NEXT_PUBLIC_GATEWAY_PORT}
ENV NEXT_PUBLIC_GATEWAY_PROTOCOL=${NEXT_PUBLIC_GATEWAY_PROTOCOL}
ENV NEXT_PUBLIC_GATEWAY_REVERSE_PROXY=${NEXT_PUBLIC_GATEWAY_REVERSE_PROXY}
ENV NEXT_PUBLIC_GATEWAY_CLIENT_ID=${NEXT_PUBLIC_GATEWAY_CLIENT_ID}
ENV NEXT_PUBLIC_GATEWAY_OPTIONAL=${NEXT_PUBLIC_GATEWAY_OPTIONAL}
ENV NEXT_PUBLIC_COORDINATOR_AGENT=${NEXT_PUBLIC_COORDINATOR_AGENT}
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_CLIENT_ID}
ENV GATEWAY_PROTOCOL_VERSION=${GATEWAY_PROTOCOL_VERSION}
ENV GATEWAY_SCOPES=${GATEWAY_SCOPES}
ENV DISPLAY_NAME_MISSION_CONTROL=${DISPLAY_NAME_MISSION_CONTROL}
ENV GATEWAY_CLIENT_ID=${GATEWAY_CLIENT_ID}
ENV GATEWAY_DEVICE_AUTH_PAYLOAD=${GATEWAY_DEVICE_AUTH_PAYLOAD}
# ────────────────────────────────────────────────────────────────────────────

RUN NODE_OPTIONS=--max-old-space-size=3072 pnpm build

# ── Stage 3: runtime hardened ──────────────────────────────────
FROM node:22.22.0-slim AS runtime

ARG MC_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/popcomputadores-desenv/mission-control.git"
LABEL org.opencontainers.image.description="Mission Control - Dashboard de Operações"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${MC_VERSION}"

WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# curl, CA certs, python3, git needed for agent runtime installers (OpenClaw, Hermes)
# procps provides `ps` and `uptime` used by system-monitor APIs
RUN apt-get update && apt-get install -y curl ca-certificates python3 git make g++ procps --no-install-recommends && rm -rf /var/lib/apt/lists/*
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/src/lib/schema.sql ./src/lib/schema.sql
# node-pty is a native addon; Next standalone tracing can omit built artifacts.
# Copy the fully installed package (including native binary artifacts) from deps stage.
COPY --from=deps /app/node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty ./node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty
# Create data directory with correct ownership for SQLite
RUN mkdir -p .data /home/nextjs && chown -R nextjs:nodejs .data /home/nextjs

# OpenClaw CLI — copiado desde la imagen openclaw en lugar de npm install
# El binario usa import.meta.url para resolver dist/ relativo a sí mismo:
#   new URL("./dist/entry.mjs", import.meta.url)  → /usr/local/bin/dist/entry.mjs
# Por tanto copiamos el binario Y su dist/ al mismo directorio padre.
COPY --from=openclaw-bin /usr/local/bin/openclaw /usr/local/bin/openclaw
COPY --from=openclaw-bin /app/dist /usr/local/bin/dist
COPY --from=openclaw-bin /app/node_modules /usr/local/bin/node_modules
COPY --from=openclaw-bin /app/package.json /usr/local/bin/package.json

RUN echo 'const http=require("http");const r=http.get("http://localhost:"+(process.env.PORT||3000)+"/api/status?action=health",s=>{process.exit(s.statusCode===200?0:1)});r.on("error",()=>process.exit(1));r.setTimeout(4000,()=>{r.destroy();process.exit(1)})' > /app/healthcheck.js
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 755 /app/docker-entrypoint.sh && \
    chmod -R a+rX /app/public/ /app/src/
USER nextjs
ENV HOME=/home/nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/healthcheck.js"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
