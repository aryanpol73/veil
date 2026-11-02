# syntax=docker/dockerfile:1
#
# Veil blind relay. Stateless and RAM-only: restarting the container is a
# complete wipe of all buffered mail, by design. Terminate TLS in front of it
# (see deploy/docker-compose.yml); the relay itself speaks plain ws:// on
# VEIL_PORT and must not be exposed directly to the internet.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production \
    VEIL_PORT=8443
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${VEIL_PORT}/healthz" >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/relay.js"]
