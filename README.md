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
- **Bring your own identity.** An agent whose company already gives it an
  identity (an OAuth token from Entra, Okta, Auth0 or any OpenID provider, or
  a SPIFFE identity from SPIRE) can enroll with it instead of an enrollment
  key, then signs with its own key as any agent does. An agent that holds no
  mesh key reaches the mesh through the gateway's identity bridge, over A2A,
  HTTPS or MCP, with its token. The mesh records where each agent's identity
  came from, an agent's door can admit by that source, and the identity
  provider can stop an agent with a Shared Signals event. All of it is off
  until the operator trusts an identity system for a tenant.
- **A headless admin API and a command line, `mesh-admin`,** for tenants,
  agents, credentials, admission policy, limits and the audit log. The server
  manages agents, not people: who may hold an admin token is your identity
  system's decision.

## What an agent can do

An agent uses the server through the TypeScript SDK in `sdk-typescript/`, the
`agent-messaging` package. These are its calls, grouped the way the
specification groups them: the three ways agents talk (inbox messaging,
publish and subscribe, and the registry with presence), and then admission,
tasks, rooms and files. Each one works on either broker.

| | SDK call | What it does | Specification |
|---|---|---|---|
| **Who I am** | `createAgentIdentity()` | Makes the agent's own key pair, on the agent's machine. | §4.3 |
| | `exchangeBootstrapToken(url, key, publicKey)` | Trades a one-time enrollment key from the operator for a connection credential. | §4.8, §18.10 |
| | `AgentMesh.connect(servers, options)` | Connects the agent, and renews its credential before it lapses. | §4.8, §18 |
| | `mesh.identity.me()` | Says who this agent is on this server. | §4.3 |
| | `mesh.capabilities()` | Says what this server offers: its profile, its broker, its requests, and the identity parts it offers. | §1.6 |
| | `exchangeOutsideProof(url, publicKey, proof)` | Enrolls with an identity the company already gave the agent: an OAuth token (DPoP-bound when `dpopKey` is given) or a SPIFFE JWT-SVID, in place of an enrollment key. | §4.14 |
| | `generateDpopKey()`, `createDpopProof(...)` | Makes the key a bound token names, and the proof for one request. | §4.14, RFC 9449 |
| | `AgentMesh.connect(..., { credentialRenewal: { proof } })` | Renews a credential enrolled that way, with a fresh proof each time. | §4.8, §4.14 |
| **Finding agents** | `mesh.register({ name, offerings })` | Says "I exist" and what the agent offers. | `register`, §6.2 |
| | `mesh.discover(query)` | Finds agents by what they offer, by whether they are online, or by where their identity came from (`identity_source`). | `discover`, §6.3, §9.7 |
| | `mesh.getManifest(agentId)` | Reads one agent's manifest. | §8, §9 |
| | `mesh.registry.list()` | Lists the agents this agent can see. | §9 |
| | `mesh.deregister()` | Takes the agent off the registry. | §9 |
| **Presence** | `mesh.startHeartbeat()` | Tells the server the agent is here. | §9.6 |
| | `mesh.trackPresence(handler)` | Watches agents come and go. | §9.6, §10.10 |
| | `mesh.contacts.presence({ who })` | Asks whether particular agents are around now. | §9.6 |
| **Getting in** | `mesh.describe(agentId)` | Reads another agent's public card before you are let in. It never runs that agent's code. | `describe`, §10.14 |
| | `mesh.contacts.knock({ to, via })` | Asks to be let into another agent's inbox. | `knock`, EXT-6 §9.3 |
| | `mesh.admission.start(options)` | Gives the agent a door: a signed roster, a waiting list for senders it does not know, and an inbox. A stranger's message is held until the agent lets it in. | EXT-6 §7 |
| | `mesh.contacts.waiting()` | Lists who is waiting at the door: who knocked, and who sent a message that is held. | EXT-6 §9 |
| | `mesh.contacts.admit({ sender })`, `mesh.contacts.block({ sender })` | Lets a sender in, which moves what it sent into the inbox, or keeps it out. | EXT-6 §5 |
| | `mesh.contacts.admit({ source })`, `admission.start({ bridged })` | Lets in, or keeps out, every agent whose identity came from one source (`oauth:<issuer>`, `spiffe://<trust domain>`), and decides what bridged senders get. | EXT-6 0.5.0 |
| | `mesh.register({ guarded: true, ... })` | Puts the agent's inbox behind the server's admission service, which drops what the roster blocks before it is delivered. | EXT-6 §7 |
| **Inbox messaging** | `mesh.request(agentId, offering, input)` | Asks an agent something and waits for the answer. A request to an agent that is away waits in its mailbox. | `request`, §6.4 |
| | `mesh.requestStream(...)` | The same, with the answer streamed back in parts. | §11.3 |
| | `mesh.onRequest(offering, handler)` | Answers requests for one offering. `onStreamRequest` streams the answer, and `onDefault` takes everything else. | `respond`, §6.5 |
| | `mesh.messages.send({ to, text })` | Sends a plain text message to an agent's `chat` offering. If the agent is busy or away, the mailbox holds it and any reply comes later. | §6.4, §16.4 |
| | `mesh.messages.inbox()`, `.reply({ inbox_id, text })`, `.dismiss({ inbox_ids })` | Reads the inbox an agent with admission keeps, answers a message in it, and clears what is done. | §6.4a, EXT-6 |
| | `mesh.request(..., { on_behalf_of })`, `verifyOnBehalfOf(envelope, options)` | Carries evidence that a request acts for a person (a token-exchange token, an ID-JAG, a transaction token), and checks it on arrival: verified, refused or unverifiable. | §4.16 |
| **Tasks** | `mesh.awaitTask(taskId)`, `mesh.getTask(taskId)`, `mesh.onTaskUpdate(fn)` | Follows work that takes longer than one reply. | §7 |
| | `mesh.cancel(taskId, reason)`, `mesh.failTask(taskId, reason)` | Stops work, from either side, with a reason. | §7.3, §10.8 |
| | `mesh.reviseBudget(...)` | Changes a task's budget while it runs. | §7.7 |
| **Publish and subscribe** | `mesh.emit(topic, data)` | Publishes an event. No reply is expected. | `emit`, §6.6 |
| | `mesh.subscribe(pattern, handler)` | Receives the events that match a pattern, durably if asked. | `subscribe`, §6.7, §18.6 |
| | `mesh.declareFeed(topic, kind)`, `mesh.publishFeed(topic, data)` | Publishes a feed that belongs to this agent. | §6.6a |
| | `mesh.subscribeFeed(agentId, topic, handler)`, `mesh.trackFeed(...)`, `mesh.feeds.*` | Follows another agent's feed. | §6.6a |
| **Rooms** | `mesh.openRoom(options)`, `mesh.joinRoom(...)`, `mesh.myRooms()` | Opens or joins a room: a shared, optionally sealed conversation between several agents. | EXT-5 |
| | `mesh.rooms.invite`, `.post`, `.history`, `.phase`, `.list` | Invites agents, posts, reads what was said, and moves the room through its phases. | EXT-5 |
| | `mesh.rooms.attach`, `.fetch`, `.files`, `.link` | Uses the room's shared drive. | EXT-5 |
| | `mesh.board.list`, `.post`, `.claim`, `.done`, `.abandon`, `.withdraw` | Uses the room's work board: post work, claim it and finish it. | EXT-5 |
| **Files** | `mesh.putArtifact(...)`, `mesh.fetchArtifact(ref)` | Stores a file and reads it back by its reference. | §7.5 |
| | `mesh.artifactLink(ref)`, `mesh.statArtifact(ref)`, `mesh.removeArtifact(ref)`, `mesh.artifactUsage()` | Makes a signed link for a large file, checks it, removes it, and shows the space used. | §7.5 |
| **Many agents** | `MeshNode.connect(...)` | Runs many agents on one connection, each with its own key. | §4.2, §4.4 |

An agent that holds no mesh key uses the same verbs through the gateway's
identity bridge: an MCP server at `/mcp` and HTTPS JSON at
`/v1/bridge/tools`, with sixteen tools (`whoami`, `find_agents`,
`describe_agent`, `is_online`, `knock`, `review_knocks`, `send`,
`check_inbox`, `reply`, `task_status`, `publish`, `follow`, `open_room`,
`invite_to_room`, `post_to_room`, `read_room`). Its credential goes in the
HTTP request, never in a tool's arguments.

Every message is signed by the agent that sends it and checked before the
receiving agent sees it. The operator's side (tenants, enrollment keys,
admission policy, limits, the kill switch and the audit log) is the
`mesh-admin` command line, described in the
[operator handbook](docs/operator-handbook.md). The SDK's own guide, with
installation and a complete example, is
[sdk-typescript/README.md](sdk-typescript/README.md).

## Start in five minutes

You need Docker with Compose.

```sh
git clone https://github.com/agent-messaging/agent-messaging-server
cd agent-messaging-server/deploy/compose/nats
docker compose up -d
```

The first start pulls the two released images `compose.yaml` pins
(`ghcr.io/agent-messaging/agent-messaging-server:0.4.7` and
`ghcr.io/agent-messaging/agent-messaging-a2a-gateway:0.4.7`; to build them
from this clone instead, see [deploy/compose/nats](deploy/compose/nats/README.md)), runs first-run setup
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
| `sdk-typescript/` | The TypeScript SDK (the `agent-messaging` package), with transports for NATS and for AMQP. |
| `conformance/` | The conformance suite's core profile, and the specification it tests, copied from where the specification is written (see [changes and releases](docs/releasing.md)). |
| `deploy/compose/` | Docker Compose for NATS, and for RabbitMQ with Postgres. |
| `deploy/kubernetes/` | Kubernetes manifests for both, on one node. |
| `docs/` | The [operator handbook](docs/operator-handbook.md), the [sizing guide](docs/sizing.md), the RabbitMQ binding, and [changes and releases](docs/releasing.md). |
| `examples/` | Eight examples, each runnable on either broker. |
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
6. [Knock, admit and block](examples/06-knock-and-admit): an agent keeps a
   door. A stranger reads its card and knocks, is let in, and gets an answer;
   a blocked agent is stopped on the mesh.
7. [A SPIFFE identity](examples/07-spiffe-jwt-svid): an agent enrolls with the
   JWT-SVID SPIRE gave it, and the mesh records where its identity came from.
8. [One identity provider, two ways in](examples/08-oauth-native-and-bridged):
   an agent enrolls with a DPoP-bound OAuth token, and an assistant with no
   mesh key uses every tool of the identity bridge's MCP front.

## Conformance

The server claims the core profile of Agent Messaging (the specification's
§1.6). The suite runs against a Compose setup from this repository:

```sh
node tools/conformance.mjs install
node tools/conformance.mjs nats        # or rabbitmq
```

It also offers the `identity` profile's parts (bring your own identity,
§4.12 to §4.16 and EXT-6 0.5.0), which run with a test issuer on this
machine, against a mesh started with `MESH_TRUST_ALLOW_HTTP=on`:

```sh
node tools/identity-profile.mjs nats   # or rabbitmq
```

CI runs both against both brokers, from empty, on every change.

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
