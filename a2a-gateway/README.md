# The A2A gateway

The gateway is a mesh node that connects Agent Messaging and A2A in both
directions:

- **Inbound:** an A2A client calls a mesh agent through the gateway. The
  gateway serves the agent's card, made from its manifest, and carries each
  A2A message over the mesh as a request from a hosted identity it keeps for
  that caller.
- **Outbound:** an A2A agent is attached to the gateway and appears on the
  mesh as an agent with a key of its own, offering its A2A skills.

The normative mapping is [MAPPING.md](MAPPING.md).

## Running it

The Compose setups and the Kubernetes manifests run it. On its own:

```sh
node --import tsx src/main.ts
```

One process, started directly, so a stop signal reaches the process that owns
the port.

| Setting | Default | What it does |
|---|---|---|
| `MESH_URL` | `ws://localhost:4443` | The mesh: `ws://`, `wss://` or `nats://` on NATS, `amqp://` or `amqps://` on RabbitMQ. First-run writes it into `a2a-gateway.env`. |
| `CREDS_FILE` | none | The gateway's node credential (`creds/a2a-gateway.creds` from first-run). |
| `PORT` | `8090` | The HTTP port. |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | The address written into the agent cards it serves. |
| `API_KEYS` | none | `key=label,...`: A2A callers presenting a key get a stable hosted identity. |
| `ALLOW_ANONYMOUS` | off | Admit callers with no key at all. |
| `TRUSTED_PROXIES` | none | Addresses whose `X-Forwarded-For` is believed, or `loopback`. |
| `RATE_PER_MINUTE` | `30` | Inbound requests per minute, per caller. |
| `ATTACH`, `ATTACH_FILE` | none | A2A agents to attach at start. |
| `ATTACHMENTS_FILE`, `API_KEYS_FILE`, `CALLER_IDS_FILE` | `./data/…` | What the gateway keeps between starts. |
| `FORWARD_ROUTES` | none | Path prefixes another front end on the same host answers. |
| `CLEARING_URL` | none | A ledger that speaks the clearing HTTP contract, for priced attachments. Unset, the gateway prices nothing. |

**It fails closed.** With no `API_KEYS` and `ALLOW_ANONYMOUS` off, every inbound
A2A call is refused with 401 until the operator makes a key, and the gateway
says so at start.

**Its admin routes** (`/admin/attachments`, `/admin/keys`, `/admin/callers`)
answer only callers on the gateway's own host that did not come through a
proxy.

**An attached agent's owner can say what its card cannot**: what it refuses
to do, and what records it keeps of each task. Send `statement: { refusals,
records }` with `POST /admin/attachments`, or replace it later with `PUT
/admin/attachments/:id/statement` (an empty body clears it). `refusals` is up
to 2000 characters of prose; `records` is up to 20 distinct names of up to 120
characters each. While a statement is set, the gateway puts an
`agent-descriptor-v1` descriptor to the registry as the attached agent's own
identity each time the agent comes up, built from the card, the exposed
offerings and the statement. The record shows when that last worked
(`descriptorPublishedAt`) or why it did not (`descriptorError`); a failed put
never takes the agent off the mesh.

## Development

```sh
npm ci
npm run typecheck
npm test
```

`__tests__/live-mesh.test.ts` runs against a live mesh when
`GATEWAY_TEST_MESH_URL`, `GATEWAY_TEST_CREDS_FILE` and
`GATEWAY_TEST_AGENT_CREDS_FILE` are set, and skips otherwise.
