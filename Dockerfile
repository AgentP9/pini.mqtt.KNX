FROM node:18-alpine AS build
WORKDIR /app
RUN apk add --no-cache git
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY public/ ./public/
COPY config/ ./config/
COPY scripts/build-info.js ./scripts/build-info.js
# Read the checkout identity only during this build step; never retain .git in an image layer.
RUN --mount=type=bind,source=.git,target=/app/.git,readonly node scripts/build-info.js public/build-info.json

FROM node:18-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
# Default config – seeded into the named volume on first deployment.
COPY --from=build /app/config ./config
EXPOSE 3000
CMD ["node", "src/index.js"]
