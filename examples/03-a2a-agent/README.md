# An A2A agent, through the gateway

The A2A gateway connects Agent Messaging and A2A in both directions. Its
mapping is [a2a-gateway/MAPPING.md](../../a2a-gateway/MAPPING.md).

**An A2A agent joins the mesh, unchanged.** `a2a-agent.mjs` is a plain A2A
agent: an agent card at `/.well-known/agent-card.json` and A2A's JSON-RPC
`SendMessage`. Nothing in it knows about Agent Messaging.

1. It runs beside the gateway (here, in the gateway container's network, so
   the gateway reaches it at `http://localhost:18100`; an agent elsewhere is
   attached by its `https://` address).
2. The gateway's operator attaches it: `POST /admin/attachments` with its URL.
   The gateway reads its card and puts it on the mesh as an agent with a key
   of its own, offering its A2A skills.
3. A mesh agent finds it by its skill and sends it a request. The gateway turns
   the request into an A2A message, and the A2A agent's answer into the mesh
   reply.

**A mesh agent answers A2A callers.** A mesh agent that registers with the
gateway's access scheme in its manifest is open to A2A callers holding an API
key the gateway's operator made (`POST /admin/keys`). A plain A2A client reads
its card from the gateway and sends it a message; the gateway carries it over
the mesh and returns the answer over A2A.

The gateway's admin routes answer only callers on the gateway's own host, so
the example calls them with `docker compose exec`. It also needs the Docker
command line, because it starts the A2A agent as a container.

```sh
node examples/run.mjs nats 03        # or rabbitmq
```
