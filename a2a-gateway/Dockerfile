# The A2A gateway of the Agent Messaging Server.
#
#   docker build -f a2a-gateway/Dockerfile -t agent-messaging-a2a-gateway .
#
# The build context is the repository root: the gateway imports the TypeScript
# SDK's source by relative path (../../sdk-typescript/src), so the image needs
# both folders side by side, each with its own dependencies.

# ---- dependencies -----------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY a2a-gateway/package.json a2a-gateway/package-lock.json ./a2a-gateway/
COPY sdk-typescript/package.json sdk-typescript/package-lock.json ./sdk-typescript/
# The gateway runs through tsx (node --import tsx), so tsx is needed at run
# time even though package.json lists it for development. Do not add
# --omit=dev to the second install: it would leave tsx out again.
RUN cd a2a-gateway \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm i --no-save --no-audit --no-fund tsx@^4.19.2
RUN cd sdk-typescript && npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=deps /app/a2a-gateway/node_modules ./a2a-gateway/node_modules
COPY --from=deps /app/sdk-typescript/node_modules ./sdk-typescript/node_modules
COPY a2a-gateway/ ./a2a-gateway/
COPY sdk-typescript/ ./sdk-typescript/

WORKDIR /app/a2a-gateway
ENV NODE_ENV=production

# What the gateway keeps: its outbound attachments, self-serve API keys (hashes
# only) and the hosted identities of its callers (data/, read at start).
# Owned by the unprivileged user; mount a volume here to keep it.
RUN mkdir -p /app/a2a-gateway/data && chown node:node /app/a2a-gateway/data && chmod 700 /app/a2a-gateway/data

# Where the mesh is. The scheme picks the transport: ws:// (NATS over
# WebSocket) or amqp:// (RabbitMQ). First-run setup writes the right address
# and the gateway's credential into a2a-gateway.env. Inside Compose and the
# Kubernetes manifests the NATS broker is the service named nats.
ENV MESH_URL=ws://nats:4443

# Declared with a value: an empty PORT would be read as 0, a port nobody
# published.
ENV PORT=8090
EXPOSE 8090

# Settings left undeclared on purpose, because an empty value is not the same
# as an absent one here:
#   PUBLIC_BASE_URL  the address written into every agent card the gateway
#                    makes; unset it is http://localhost:$PORT.
#   CREDS_FILE       the gateway's node credential (a2a-gateway.creds from
#                    first-run). Mount it read-only.
#
# The gateway fails closed: with no API_KEYS and ALLOW_ANONYMOUS off it starts,
# says so in its log, and refuses every inbound A2A call with 401.

USER node

# node directly, not npm start, so this process is PID 1 and SIGTERM reaches
# the process that owns the socket. /healthz answers 503 with ready:false until
# the mesh connection is up, then 200 with ready:true.
CMD ["node", "--import", "tsx", "src/main.ts"]
