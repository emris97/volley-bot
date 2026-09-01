# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS pnpm-base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /workspace

FROM pnpm-base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/telegram/package.json packages/telegram/package.json

FROM manifests AS build-dependencies
RUN pnpm install --frozen-lockfile

FROM build-dependencies AS build
COPY . .
RUN pnpm build
RUN find dist packages/*/dist -type f \( -name '*.spec.js' -o -name '*.spec.js.map' -o -name '*.spec.d.ts' -o -name '*.spec.d.ts.map' -o -name '*.tsbuildinfo' \) -delete

FROM manifests AS production-dependencies
RUN pnpm install --prod --frozen-lockfile

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json ./package.json
COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /workspace/apps ./apps
COPY --from=production-dependencies --chown=node:node /workspace/packages ./packages
COPY --from=build --chown=node:node /workspace/dist/apps/worker ./apps/worker/dist
COPY --from=build --chown=node:node /workspace/packages/application/dist ./packages/application/dist
COPY --from=build --chown=node:node /workspace/packages/config/dist ./packages/config/dist
COPY --from=build --chown=node:node /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /workspace/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=node:node /workspace/packages/persistence/dist ./packages/persistence/dist
COPY --from=build --chown=node:node /workspace/packages/telegram/dist ./packages/telegram/dist
COPY --chown=node:node --chmod=755 docker/entrypoint-worker.sh /usr/local/bin/entrypoint-worker
USER node
ENTRYPOINT ["entrypoint-worker"]
CMD ["serve"]
