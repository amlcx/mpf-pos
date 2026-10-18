# The server: API plus the admin panel it serves at /panel/.
# The register (apps/desktop) is not part of this image.
#
# Node runs the API's TypeScript directly and refuses to do that for files
# inside node_modules, so the image keeps the workspace layout (packages/shared
# linked, not copied) instead of using `pnpm deploy`.

# Built for amd64 and arm64 (the server is arm64). Only the runtime stage is
# per platform; the panel is static files, so it is built once, natively.

# Manifests only, so dependency layers are reused until a package.json changes.
FROM scratch AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /app/
COPY packages/shared/package.json /app/packages/shared/
COPY packages/brand/package.json /app/packages/brand/
COPY apps/api/package.json /app/apps/api/
COPY apps/admin/package.json /app/apps/admin/
COPY apps/desktop/package.json /app/apps/desktop/

FROM --platform=$BUILDPLATFORM node:24-slim AS panel
RUN npm install -g pnpm@11.3.0
WORKDIR /app
COPY --from=manifests /app ./
RUN pnpm install --frozen-lockfile --filter "@mpf/admin..."
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/admin apps/admin
RUN pnpm --filter @mpf/admin build

FROM node:24-slim AS runtime
RUN npm install -g pnpm@11.3.0
WORKDIR /app
COPY --from=manifests /app ./
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter "@mpf/api..."
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY --from=panel /app/apps/admin/dist apps/admin/dist
USER node
WORKDIR /app/apps/api
ENV PORT=8787
# Set by release.yml from the git tag; /health reports it. Last, so a new
# version does not invalidate the layers above.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/main.ts"]
