# The Agent Messaging Server.
#
#   docker build -f server/Dockerfile -t agent-messaging-server .
#
# The build context is the repository root: the server imports the TypeScript
# SDK's source by relative path (../../sdk-typescript/src).
#
# One image for both brokers (MESH_BROKER, which first-run writes into
# server.env), and three commands (server-entrypoint.sh):
#
#   docker run --rm -v mesh-config:/config IMAGE first-run      once, before the first start
#   docker run -v mesh-config:/config IMAGE                      the server
#   docker run --rm -v mesh-config:/config IMAGE mesh-admin status
#
# The broker reads the same volume: nats -c /config/nats/nats.conf, or
# RabbitMQ with RABBITMQ_CONFIG_FILE=/config/rabbitmq/rabbitmq.conf.

# ---- dependencies -----------------------------------------------------------
# Debian rather than Alpine: better-sqlite3 (the audit log) ships glibc prebuilds.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
COPY sdk-typescript/package.json sdk-typescript/package-lock.json ./sdk-typescript/
# The server runs through tsx rather than compiled output, so tsx is needed at
# run time even though package.json lists it for development.
RUN cd server \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm i --no-save --no-audit --no-fund tsx@^4.19.2
RUN cd sdk-typescript && npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/sdk-typescript/node_modules ./sdk-typescript/node_modules
COPY sdk-typescript/ ./sdk-typescript/
COPY server/package.json server/tsconfig.json server/server-release.json ./server/
COPY server/tools/ ./server/tools/
COPY server/src/ ./server/src/

WORKDIR /app/server
ENV NODE_ENV=production

# The release number, from server/server-release.json, baked in by the release
# workflow. A local build leaves it empty, and the server then says it runs
# from source rather than claim a release.
ARG MESH_SERVER_VERSION=""
ENV MESH_SERVER_VERSION=${MESH_SERVER_VERSION}

# The folder first-run fills and the server reads: keys, credentials, the
# broker's settings, server.env and the SQLite files. Owned by the unprivileged
# user, so a new named volume mounted on it is writable by first-run. This is
# the one volume to back up.
ENV MESH_CONFIG_DIR=/config
RUN mkdir -p /config && chown node:node /config && chmod 755 /config

# Inside a container the broker is another container. The code's own default is
# localhost, which would be this container. Overrides server.env's NATS_URL; a
# RabbitMQ server is pointed at its broker with MESH_AMQP_URL instead.
ENV NATS_URL=nats://nats:4222

# The credential doors and the admin API listen on every interface inside the
# container, so a published port reaches them. The admin API still needs an
# admin token, and refuses a request that came through a proxy unless
# MESH_ADMIN_THROUGH_PROXY=on.
ENV MESH_API_HOST=0.0.0.0
EXPOSE 3005

COPY server/server-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER node
ENTRYPOINT ["/entrypoint.sh"]
