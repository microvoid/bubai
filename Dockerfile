# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN npm install --global pnpm@11.13.0

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json turbo.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/botmux-client/package.json ./packages/botmux-client/
COPY packages/chat-client/package.json ./packages/chat-client/
COPY packages/design-tokens/package.json ./packages/design-tokens/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --filter @buzz-botmux/server... --filter @buzz-botmux/web... --frozen-lockfile

# Copy source code
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY scripts ./scripts

# Build web frontend (defaults to window.location.origin in production)
ARG VITE_SERVER_URL=""
ENV VITE_SERVER_URL=${VITE_SERVER_URL}
RUN cd apps/web && ./node_modules/.bin/vite build

# Runtime image
FROM oven/bun:1.3-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
ENV STATIC_DIR=/app/apps/web/dist

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/server ./apps/server
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/scripts ./scripts

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

WORKDIR /app/apps/server
CMD ["bun", "src/main.ts"]
