# Examples

Five examples, each a working program that runs on either broker with the
same code:

| | |
|---|---|
| [01-two-companies](01-two-companies) | Agents in different companies message each other, including while one is offline. |
| [02-internal-network](02-internal-network) | A Claude Code agent and a LangChain agent work together inside one company. |
| [03-a2a-agent](03-a2a-agent) | An existing A2A agent joins through the gateway, unchanged; an A2A client reaches a mesh agent. |
| [04-kill-switch](04-kill-switch) | Revoke an agent and watch it get cut off live. |
| [05-room](05-room) | Three agents share files and work on one task in a room. |

## Running them

Start one of the Compose setups first (`deploy/compose/nats` or
`deploy/compose/rabbitmq`, `docker compose up -d`), then from this folder:

```sh
cd ../sdk-typescript && npm ci && npm run build && cd ../examples
npm ci
node run.mjs nats            # or: node run.mjs rabbitmq
node run.mjs nats 01 04      # only some of them
```

`run.mjs` copies the admin token out of the Compose volume into `.state/` (it
never prints it), runs each example and says which passed. Each example makes
its own tenants and agents with the admin API, as the mesh's operator would,
with a suffix that keeps runs apart, so they can run again and again on one
mesh.

If you changed the Compose host ports, set the same `SERVER_PORT` and
`GATEWAY_PORT` here.

## How an example's agents get on the mesh

`lib/mesh.mjs` holds what they share:

1. The operator makes a tenant (`POST /admin/v1/tenants`) and a one-time
   enrollment key for it (`POST /admin/v1/tenants/<id>/enroll-keys`), which is
   what `mesh-admin tenants key` does.
2. The agent makes its own key pair and redeems the enrollment key at
   `/v1/bootstrap` (the SDK's `exchangeBootstrapToken`). The answer is a
   connection credential and a `mesh` object naming the broker's addresses.
3. The agent connects to the addresses the `mesh` object names
   (`transportFromMesh`): `ws://` or `nats://` on NATS, `amqp://` on RabbitMQ.
   Nothing else in the agent's code depends on the broker.

The examples use this repository's SDK from `../sdk-typescript/dist`. An agent
of your own installs the released SDK, the `agentmesh` package:

```sh
npm install https://storage.googleapis.com/agentmesh-releases/agentmesh-0.58.2.tgz
```
