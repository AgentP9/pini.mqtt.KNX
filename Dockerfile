FROM node:18-alpine AS build
WORKDIR /app
RUN apk add --no-cache git
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY public/ ./public/
COPY config/ ./config/
COPY scripts/build-info.js ./scripts/build-info.js
# Build from a verified git archive. The builder supplies the branch and
# immutable commit; neither .git nor a version file is required in the context.
ARG BUILD_SOURCE_REPOSITORY=https://github.com/AgentP9/piniMqtt4KNX.git
ARG BUILD_SOURCE_BRANCH
ARG BUILD_SOURCE_COMMIT
RUN --mount=type=tmpfs,target=/tmp/build-info-git,size=64m \
    TMPDIR=/tmp/build-info-git node scripts/build-info.js public/build-info.json \
    "$BUILD_SOURCE_REPOSITORY" "$BUILD_SOURCE_BRANCH" "$BUILD_SOURCE_COMMIT"

FROM node:18-alpine
WORKDIR /app
ARG BUILD_SOURCE_BRANCH
ARG BUILD_SOURCE_COMMIT
LABEL org.opencontainers.image.revision="$BUILD_SOURCE_COMMIT" \
      org.opencontainers.image.ref.name="$BUILD_SOURCE_BRANCH"
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
# Default config – seeded into the named volume on first deployment.
COPY --from=build /app/config ./config
EXPOSE 3000
CMD ["node", "src/index.js"]
