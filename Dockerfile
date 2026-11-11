# syntax=docker/dockerfile:1
#
# One image, two roles (ROLE=web | migrate), see docker/entrypoint.sh.
# Build: docker build -t devops-manager .

ARG NODE_IMAGE=node:22-alpine
ARG PRISMA_VERSION=7.10.1

FROM ${NODE_IMAGE} AS base
RUN corepack enable
WORKDIR /app

# ---- dependencies ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1 \
    SKIP_ENV_VALIDATION=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm exec prisma generate && pnpm exec next build

# ---- prisma CLI for ROLE=migrate (kept apart from the app bundle) ----
FROM ${NODE_IMAGE} AS migrator
ARG PRISMA_VERSION
WORKDIR /opt/prisma
RUN npm init -y >/dev/null \
  && npm install --no-audit --no-fund --omit=dev "prisma@${PRISMA_VERSION}" \
  && npm cache clean --force
COPY prisma ./prisma
COPY prisma.config.ts ./

# ---- runtime ----
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app

COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
COPY --from=migrator --chown=app:app /opt/prisma /opt/prisma
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint"]
