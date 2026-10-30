# syntax=docker/dockerfile:1

# Builder stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY bin ./bin
COPY config ./config

RUN npm run build
# The runtime loads its config from dist/config and migrations from
# dist/src/db/migrations (paths are relative to the compiled output), so copy
# both alongside the build.
RUN cp -r config dist/config && \
    mkdir -p dist/src/db && \
    cp -r src/db/migrations dist/src/db/migrations

# Production stage
FROM node:20-alpine

WORKDIR /app

# clamscan (AV), and bash for the entrypoint script.
RUN apk add --no-cache clamav bash

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config ./config
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/src/db/migrations ./src/db/migrations

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Health endpoint (HEALTH_PORT, default 9090).
EXPOSE 9090

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
