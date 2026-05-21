# syntax=docker/dockerfile:1.6
#
# Next.js /inbox UI — production image.
#
# Mirrors what `./scripts/start.sh` runs as `pnpm dev` on the host, but
# built (`next build`) and served (`next start`) instead — same code, no
# HMR / Turbopack dev overhead. The relay it talks to lives in a sibling
# container; RELAY_URL is set in docker-compose.yml.

FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Corepack lets us pin pnpm without a global install — matches the
# lockfileVersion 9.x produced by pnpm 9/10.
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# next.config.ts reads RELAY_URL at request time (via rewrites()), not at
# build time, so the build is environment-agnostic. The runner stage sets it.
COPY . .
RUN pnpm build

FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

RUN corepack enable && corepack prepare pnpm@9 --activate

# Only what `next start` actually needs.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts

EXPOSE 3001

CMD ["pnpm", "start"]
