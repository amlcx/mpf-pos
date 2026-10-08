# The server: API plus the admin panel it serves at /panel/.
# The register (apps/desktop) is not part of this image.
#
# Node runs the API's TypeScript directly and refuses to do that for files
# inside node_modules, so the image keeps the workspace layout (packages/shared
# linked, not copied) instead of using `pnpm deploy`.

FROM node:24-slim AS base
RUN npm install -g pnpm@11.3.0
WORKDIR /app
# Manifests only, so dependency layers are reused until a package.json changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/brand/package.json packages/brand/
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/desktop/package.json apps/desktop/

FROM base AS panel
RUN pnpm install --frozen-lockfile --filter "@mpf/admin..."
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/admin apps/admin
RUN pnpm --filter @mpf/admin build

FROM base AS runtime
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter "@mpf/api..."
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY --from=panel /app/apps/admin/dist apps/admin/dist
USER node
WORKDIR /app/apps/api
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/main.ts"]
