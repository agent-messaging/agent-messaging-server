# Agent Messaging Server

The Agent Messaging Server is a small, headless server that lets AI agents
message each other: across companies, across frameworks, and while one side is
offline. It implements the core profile of
[Agent Messaging](https://agentmessaging.ai), an open specification for agent
to agent messaging.

It is one server with a choice of broker:

- **NATS JetStream**, or
- **RabbitMQ, with Postgres** beside it for the server's state.

Agents connect with the same SDK and the same code on either. The server is
free and open source under the Apache License 2.0, and its development is
sponsored by [AgentMesh](https://agentmesh.ai).

## What it does

- **Every agent has its own key and a mailbox.** A message to an agent that is
  away waits on the mesh and is delivered, in order, when it comes back.
- **Every message is signed.** The server checks who sent it before the
  receiving agent sees it.
- **Request and reply, events and feeds, presence, rooms with a shared drive
  and a work board, and file transfer.**
- **Tenants.** Each company or team is a tenant; the server keeps a record of
  which tenant holds each agent, and an agent nobody holds gets no credential.
- **A kill switch.** The operator revokes an agent or a whole tenant, and the
  broker cuts its connections within seconds, without a restart.
- **An A2A gateway**, so an existing A2A agent joins the mesh unchanged and a
  mesh agent can be called from any A2A client.
- **A headless admin API and a command line, `mesh-admin`,** for tenants,
  agents, credentials, admission policy, limits and the audit log. The server
  manages agents, not people: who may hold an admin token is your identity
  system's decision.

## Start in five minutes

You need Docker with Compose.

```sh
git clone https://github.com/jeffrschneider/agent-messaging-server
cd agent-messaging-server/deploy/compose/nats
docker compose up -d
```

The first start builds the two images from this clone (to run the released
images instead, set `SERVER_IMAGE=ghcr.io/jeffrschneider/agent-messaging-server:0.1.1`
and `GATEWAY_IMAGE=ghcr.io/jeffrschneider/agent-messaging-a2a-gateway:0.1.1`), runs first-run setup
once (the operator key, the signing keys, the broker's settings and the first
admin token, all in the Compose volume `config`), and starts NATS, the server
and the A2A gateway. Every port is published on 127.0.0.1 only.

```sh
docker compose exec server /entrypoint.sh mesh-admin status
```

Then run the examples, which enroll their own agents with the admin token:

```sh
cd ../../../sdk-typescript && npm ci && npm run build
cd ../examples && npm ci
node run.mjs nats
```

The first example sends a message to an agent that is offline and shows it
arriving when that agent comes back.

For RabbitMQ with Postgres, use `deploy/compose/rabbitmq` the same way, and
`node run.mjs rabbitmq`. To use a Postgres you already run, see
[its README](deploy/compose/rabbitmq/README.md).

Keep a copy of the operator key: first-run says where it is. If it is lost,
every agent's credential has to be issued again.

## Choosing a broker

| | NATS JetStream | RabbitMQ with Postgres |
|---|---|---|
| What runs | NATS and the server | RabbitMQ, Postgres and the server |
| An agent's mailbox | a JetStream stream | a durable queue, with a record in Postgres |
| The server's state | JetStream key-value buckets | Postgres tables |
| Live revocation | NATS's own account revocations | RabbitMQ asks the server about every connection; revoked connections are closed through its management API |
| Pick it when | you are starting fresh | your company already runs RabbitMQ or Postgres |

Both pass the same core conformance profile. The RabbitMQ binding is written
down in [docs/rabbitmq-binding.md](docs/rabbitmq-binding.md).

## What is in this repository

| Folder | What it is |
|---|---|
| `server/` | The server: the core services, first-run setup (`src/setup/`), the admin API (`src/admin/`), the storage layer for both brokers (`src/storage/`), and `tools/mesh-admin.mjs`. |
| `a2a-gateway/` | The A2A gateway. Its mapping between Agent Messaging and A2A is [MAPPING.md](a2a-gateway/MAPPING.md). |
| `sdk-typescript/` | The TypeScript SDK (the `agentmesh` package), with transports for NATS and for AMQP. |
| `conformance/` | The conformance suite's core profile, and the specification it tests. |
| `deploy/compose/` | Docker Compose for NATS, and for RabbitMQ with Postgres. |
| `deploy/kubernetes/` | Kubernetes manifests for both, on one node. |
| `docs/` | The [operator handbook](docs/operator-handbook.md), the [sizing guide](docs/sizing.md), the RabbitMQ binding, and [changes and releases](docs/releasing.md). |
| `examples/` | Five examples, each runnable on either broker. |
| `tools/` | The conformance runner for a Compose setup, the secret check and the boundary check. |

## The examples

1. [Two companies](examples/01-two-companies): agents in different companies
   message each other, including while one of them is offline.
2. [An internal network](examples/02-internal-network): a Claude Code agent
   and a LangChain agent work together.
3. [An A2A agent](examples/03-a2a-agent): an existing A2A agent joins through
   the gateway, unchanged, and an A2A client reaches a mesh agent.
4. [The kill switch](examples/04-kill-switch): revoke an agent and watch it get
   cut off live.
5. [A room](examples/05-room): three agents share files and work on one task.

## Conformance

The server claims the core profile of Agent Messaging (the specification's
§1.6). The suite runs against a Compose setup from this repository:

```sh
node tools/conformance.mjs install
node tools/conformance.mjs nats        # or rabbitmq
```

CI runs it against both brokers, from empty, on every change.

## Development

The server runs on Node.js 22 with TypeScript run directly by tsx.

```sh
cd sdk-typescript && npm ci && npm run build && cd ..
cd server && npm ci && npm run typecheck && npm test
```

`npm run test:integration` in `server/` runs the tests that need a live NATS,
RabbitMQ or Postgres; each skips and says what to set when its broker is not
there. `node tools/check-boundary.mjs` checks that nothing imports outside the
server, the gateway and the SDK, and that the core reaches the broker only
through its storage layer.

This repository is the only home of the server's source, and every release is
made here: a `server-v<version>` tag publishes both images
(`.github/workflows/release-images.yml`), and an `sdk-v<version>` tag releases
the SDK's tarball (`.github/workflows/release-sdk.yml`).
[docs/releasing.md](docs/releasing.md) says how a change goes from a pull
request to a release, and from a release to a deployment that pins it.

## Support and security

Questions and problems go in this repository's issues. Report a security
problem privately, as [SECURITY.md](SECURITY.md) says.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
