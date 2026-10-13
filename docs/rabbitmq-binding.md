# Agent Messaging: the RabbitMQ binding

Version 0.1, for Agent Messaging 0.7 (`SPEC.md`), core profile. Written 2026-10-12 with step 9 of
`docs/agent-messaging-server-plan.md`. It is kept in this repository for now; publishing it on agentmessaging.ai
beside the Bindings page is a later step.

SPEC.md §18 separates the abstract protocol from the binding that realizes it. §18.2 to §18.10 define the reference
binding, NATS JetStream. This document defines a second binding: RabbitMQ (AMQP 0-9-1) for messaging, with a
Postgres database beside it for state. It says how each requirement of §18.1 is met, and it documents the
mesh-server interface (§18.1, last paragraph): the wire protocol, the connection handshake, what a permission
allows, and acknowledgment, redelivery and resume.

As §18.1 says, a node built for one binding does not talk to a mesh server of another. Agents on the two bindings
interoperate at the envelope and primitive layer, not on the wire. Everything above the wire is unchanged: the
envelope (§5), signatures (§4.5), subjects (§14), the primitives (§6), tasks (§7) and the services' subjects and
answers.

Where this document says "the server", it means an Agent Messaging server running this binding (the Agent
Messaging Server with `MESH_BROKER=rabbitmq`).

## 1. What a mesh on this binding runs

- **RabbitMQ 4**, one virtual host per mesh (default `mesh`), with the management plugin and the HTTP
  authentication backend (`rabbitmq_auth_backend_http`) enabled, and `max_message_size` set to 1 MB (§18.9).
- **Postgres**, any version the server supports (tested on 18), reached by a connection URL with the password in a
  file. It holds the keyed records, the streams, the account (the binding's resolver) and the broker sessions. It
  is a separate service: an operator may point the server at a database it already runs.
- **The server**, which answers RabbitMQ's permission checks on a loopback HTTP address of its own.

## 2. The wire

The mesh-server protocol is **AMQP 0-9-1** as RabbitMQ implements it, over TCP (`amqp://`, port 5672) or TLS
(`amqps://`, port 5671). Its framing, methods and properties are defined by the AMQP 0-9-1 specification and
RabbitMQ's documentation of its extensions (direct reply-to, publisher returns, consumer cancel notification).
This document does not restate them.

### 2.1 Subjects

Every subject is published on one durable **topic exchange named `mesh`**, with the subject as the routing key,
unchanged. A routing key, like a subject, is words separated by dots.

A subscription binds a queue to the exchange with a binding key made from the subject pattern:

| Subject pattern (§14.2) | Binding key | Matches |
|---|---|---|
| a literal token | the token | that token |
| `*` | `*` | exactly one token |
| `>` (last token only) | `*.#` | one or more tokens |

AMQP's `#` alone matches zero or more words, so `mesh.event.#` would also match a message published on
`mesh.event` itself, which `mesh.event.>` does not. Writing `>` as `*.#` (one word, then any number) keeps §14.2's
meaning exactly.

Only a message published to the `mesh` exchange came on a subject. Any connection may also publish straight into a
queue by its name through the default exchange, and the broker cannot refuse that alone: the default exchange
carries the answers to direct reply-to (§2.3), and RabbitMQ checks routing keys only on topic exchanges. So every
consumer of a queue bound to `mesh` (a live subscription, a queue group, an agent's mailbox, a durable subscription,
the server's capture queue) checks each delivery before handing it on: it must have come through the `mesh` exchange
(the delivery's `exchange` field), and its routing key must match the pattern subscribed to. Anything else is dropped
(acknowledged and not handed on, where the queue takes acknowledgments), so it can never arrive as though it came on
a subject, or be kept in a stream.

### 2.2 Live delivery and queue groups

A live subscription is a **server-named, exclusive, auto-delete queue** bound to the pattern and consumed without
acknowledgment. It is the equivalent of a core NATS subscription: delivery to whoever is listening, at most once,
gone with the connection.

A queue group (the platform services' competing consumers) is one shared durable, auto-delete queue per group
and subject, `ams.group.<group>.<hash>`, which RabbitMQ gives to its consumers in turn.

### 2.3 Request-reply (§18.7)

A request is published on the subject with RabbitMQ's **direct reply-to**: `reply_to` is
`amq.rabbitmq.reply-to`, a `correlation_id` names the request, and the publisher consumes its replies from the
`amq.rabbitmq.reply-to` pseudo-queue on the same channel. The request is published with the `mandatory` flag: if no
queue is bound to the subject, RabbitMQ returns it at once, and that is the **no-responders** answer (§18.7). The
timeout is the caller's, 30 seconds by default as on NATS.

Answers go to the default exchange with the request's `reply_to` as the routing key and its `correlation_id`
copied. A reply address can also be an ordinary reply subject (`_INBOX.<token>`), bound and answered on the `mesh`
exchange. Inside a server, a reply address passed along unchanged (the admission relay) is written
`<reply_to>#<correlation_id>`, so both halves travel together.

`respond` from an agent never uses the reply address (§6.5): it is published to the requester's inbox like any
message. The two exceptions of §18.7, the registry's probe and a live guarded delivery, answer on the reply
address as described above.

An agent's inbox subject is always bound to its mailbox queue (§6.1), so a request to an agent that is away is held
for it as mail rather than returned as no-responders: the caller sees silence until its timeout, then the queued
outcome of §6.4 applies. The registry's liveness probe is the exception. It is a live request: it is published with
the per-message `expiration` of `0`, so a queue that cannot hand it to a consumer at once drops it, and the capture
(§6.3) keeps it nowhere. A probe to an agent whose node is consuming its mailbox is answered on its reply address; a
probe to an agent that is away times out, as it does on NATS, and is never delivered when the agent comes back. Node
presence (§9.6) is the other liveness signal; §18.7 allows both.

### 2.4 Message properties

| AMQP property | Use |
|---|---|
| `message_id` | The publisher's deduplication id (the envelope `id` on an `emit`), the counterpart of `Nats-Msg-Id` (§18.8) |
| `reply_to`, `correlation_id` | Request-reply (§2.3) |

Nothing else is set or read. The body is the envelope's bytes.

### 2.5 Message size (§18.9)

The broker's `max_message_size` is 1 MB, the same as the reference binding. A client refuses to publish a larger
body before sending it (`MAX_PAYLOAD_EXCEEDED`, §6.4b); larger payloads travel by reference (§7.5).

## 3. The connection handshake and identity (§4, §18.2)

RabbitMQ has no operator, account and user chain of its own. The key chain is the same as the reference binding's:
an operator, an operator signing key, and the mesh's account with its signing keys (one for the server's own
credentials, one for every node credential, which the mesh-wide pause takes out). The **account JWT**, signed by
the operator or its signing key, is this binding's resolver: the server keeps it in Postgres.

A **node credential** is the same JWT the reference binding uses (§18.2): issued by one of the account's signing
keys, its subject the node's public key, carrying the node's publish and subscribe permissions and its expiry.
The credential doors (§4.8) issue and renew it unchanged.

A node connects with SASL PLAIN:

- **user name**: `<node public key>:<the credential's jti>`;
- **password**: `<credential JWT>~<unix time in ms>~<signature>`, where the signature is the node key's Ed25519
  signature, base64url, over the bytes of `amqp-connect|<user name>|<unix time in ms>`.

RabbitMQ asks the server (its HTTP authentication backend) about the login. The server accepts it only when:

1. the JWT's signature verifies against its issuer, and the issuer is a signing key the account lists **now** (or
   the account itself), for this account;
2. the credential has not expired;
3. the account's `revocations` do not revoke it: an entry for the node key (or `*`) at an instant at or after the
   credential's `iat` revokes it, as on NATS;
4. the user name names this credential, and the signature verifies against the credential's subject key with a
   time within five minutes of the server's clock.

So a connection proves possession of the node key, as a NATS connection does by signing the server's nonce, and a
captured password stops working after five minutes. The server's own processes connect as a RabbitMQ internal
user, checked first. A login with no credential is refused (c16).

## 4. What a permission allows (§14.3)

After login, RabbitMQ asks the server about every operation that needs a permission, naming only the user. The
server answers from the credential that user name logged in with:

- **Publishing** on the `mesh` exchange with routing key R is allowed when the credential's `pub` permits subject R:
  no `deny` pattern matches R, and either there is no `allow` list or an `allow` pattern matches R (NATS's rule).
- **Binding** a queue to the `mesh` exchange with a binding key is allowed when the credential's `sub` permits the
  **whole** pattern: an `allow` pattern covers every subject the pattern can match, and no `deny` pattern overlaps
  it. NATS can admit a wide subscription and filter what a deny list forbids message by message; AMQP decides at the
  binding, so here the subscription must be no wider than what is allowed.
- **The default exchange** may be published to, for answers to direct reply-to.
- **Queues**: a node may declare and use server-named queues (`amq.gen-…`). It may read (consume, check) the mailbox
  queue `MESH_INBOX_<agent>` of an agent it hosts, and declare, bind and read that agent's durable subscription
  queues `mesh_event_<agent>_<hash>` and `mesh_feed_<agent>`. An agent is hosted by the credential when its `sub`
  allows `mesh.agent.<agent>.inbox` or `.inbox.guarded`. Every other queue, and every other exchange, is refused.
- A refused operation closes its AMQP channel with `403 ACCESS_REFUSED`; a client reports it as a permission
  violation and carries on, as a NATS client does.

The reserved `mesh.peer.>` prefix (§14.1) is in every credential's deny lists, so it is refused in both directions
(t03).

## 5. Live revocation (§4.8, §4.12)

Revocation is the key chain's own: the account JWT gains a revocation (or, for the mesh pause, loses a signing
key), re-signed by the operator signing key, and is pushed to the binding. On this binding the push is a write of
the account JWT in Postgres, refused unless the operator or its signing key signed it and it is not older than the
one held. The server then closes, through RabbitMQ's management API and its connection tracking by user name,
every connection whose credential the new account refuses, and only those: a renewed credential for the same key
(a later `iat`) stays connected. The login check (§3) refuses the closed credentials when they try to come back.
Refusing renewal is not the mechanism; the cut is live (c20: 0.2 seconds on the reference test machine).

## 6. Durable delivery: acknowledgment, redelivery and resume

### 6.1 The agent's mailbox (§16.4, §18.6)

Each registered agent (not a sandbox agent) has a **durable classic queue `MESH_INBOX_<agent>`**, made by the
registry at registration and removed with the registration, bound to the agent's inbox subject (or to its guarded
subject while admission guards it). Its limits are queue arguments: `x-message-ttl` (seven days),
`x-max-length-bytes` (25 MB) and `x-overflow: drop-head` (drop the oldest), as §18.3 gives the mailbox.

The agent's node consumes the queue with **manual acknowledgment** and a prefetch limit:

- **acknowledgment**: the node acknowledges a message once it has durably accepted it (dispatched it, or found it a
  duplicate). That is the §16.4 handoff.
- **redelivery**: a message not acknowledged when the channel or connection ends is redelivered by RabbitMQ to the
  next consumer, in queue order. A node may also return a message (`nack` with requeue).
- **resume**: the queue itself is the cursor. A node that comes back consumes from the oldest unacknowledged
  message; nothing is replayed that was acknowledged.

Once the node consumes the mailbox queue, the queue is the agent's inbox, and the node holds no live subscription on
the inbox subject beside it: each message is delivered once. A delivery carries the request's `reply_to` and
`correlation_id`, so the two reply-address exceptions of §18.7 (the probe, a guarded delivery's relay) are answered on
the reply address from the mailbox delivery. Until the registry has made the mailbox, and for a sandbox agent, which
has none, the node subscribes live (§2.2) instead. The node checks that each delivery came through the `mesh` exchange
and that its routing key is the agent's inbox subject (or its guarded subject), and drops anything else, such as a
message put into the queue by its name through the default exchange (§2.1).

The node acknowledges a delivery when its dispatch finishes, and works on up to its prefetch limit at once. A
delivery that was in the queue when the node attached, that is redelivered, or that was sent more than a minute
before it arrived is handled as mail that waited (the mailbox's freshness window, and no §6.4a accept); the rest as
live delivery.

**Removing messages.** The kill switch's "discard what was held" removes the messages that arrived while an agent
was stopped from the record and from the queue. AMQP 0-9-1 cannot remove a message by position, so the server reads
the queue through once on a channel of its own, acknowledges each message whose bytes are those of a message it
removed from the record, and closes the channel, which returns every other message to its place in order. A message
the agent's node has already taken is in its hands and out of reach; while an agent is stopped its node's credential
no longer covers the mailbox, so nothing is taking it.

### 6.2 Durable subscriptions (§6.7, §6.6a, §18.6)

A durable event subscription is a **durable queue named as the reference binding names its consumer**,
`mesh_event_<agent_id>_<16 hex of sha256(pattern)>`, bound to `mesh.event.<pattern>`. A durable feed subscription
is one durable queue per agent, `mesh_feed_<agent_id>`, bound to every feed it follows. Acknowledgment, redelivery
and resume are as in §6.1: the queue keeps what is published while the agent is away, from when it was first made.
There is no replay of what was published before the queue existed (the reference binding's `DeliverPolicy.All`).
A delivery that did not come through the `mesh` exchange is dropped, as in §2.1.

### 6.3 Streams the server keeps (§18.3)

`MESH_EVENTS`, `MESH_FEED` (with the state feeds' latest values), the metering and trace streams, each room's
record and each mailbox's record are tables in Postgres, by sequence. One durable queue, `ams.capture`, is bound to
every one of their subjects and consumed by a single active consumer, which writes each message into every stream
whose subjects it matches and acknowledges it to RabbitMQ only once Postgres holds it. Their durable consumers
(the server's own: the metering fold, the feed state writer, the audit backstop) keep their place in Postgres,
with per-message acknowledgment and delayed redelivery.

These streams keep their limits by age, count and size. They keep a day whether or not anything consumes them:
there is no interest retention here, so this binding keeps more than the reference binding, never less (§18.3's
note on interest retention does not apply).

## 7. Deduplication (§18.1, §18.8, §22.2)

There is no publish-side deduplication in RabbitMQ. Deduplication happens **on receipt**:

- in the server's streams, each message's key is the envelope's `(from, id)` when it is a signed envelope, else the
  publisher's `message_id`, and a repeat inside the stream's two-minute window is dropped (§18.8's window);
- at every receiver, the §22.2 memory as on any binding.

## 8. The other §18.1 requirements

| §18.1 requirement | On this binding |
|---|---|
| Addressing | §2.1: subjects as routing keys on one topic exchange, `*` and `>` with §14.2's meaning |
| Delivery: ordered, at least once, deduplicated on `(from, id)` | Per-queue order; manual acknowledgment with redelivery (§6); deduplication on receipt (§7) |
| Durable publish and subscribe | §6.2 and §6.3 |
| Request-reply with a reply address and a timeout | §2.3, direct reply-to with publisher returns |
| Durable task store | `mesh_tasks` as keyed records in Postgres: one row per task with a revision that grows on every write, compare-and-set on it, seven-day expiry (§18.4's settings) |
| Large-payload storage | The artifact store and room drive on disk or Google Cloud Storage (§18.5 already allows either) |
| Identity and credentials | §3 to §5 |
| Tenant import and export | Not offered: the server runs its tenants in one virtual host as records it enforces itself, the tenancy model §1.6 allows (the capabilities answer says `one_rabbitmq_vhost`) |
| Presence with TTL expiry | Node heartbeats on `mesh.heartbeat.<node>` over the exchange; the registry keeps presence in Postgres (`mesh_presence_agent`), takes a node offline when its signed heartbeats stop for longer than the time to live, and §9.6's lookup answers from it (c06, c23) |

## 9. Finding the mesh (§18.10)

A credential-issuing answer from a mesh on this binding carries the `mesh` object of SPEC.md §18.10 with the
broker's addresses in `endpoints`, a list of URLs whose scheme names the binding. This binding's schemes are
`amqp://` and `amqps://` (`amqp://host:5672/mesh`, the path naming the virtual host). A client dials the first
address whose scheme it speaks. `nats_endpoints`, which only the reference binding needs, is sent as an empty list.

The capabilities answer (`GET /v1/capabilities`) says `"binding": "rabbitmq"`.

## 10. Conformance

The core conformance profile (`conformance/run.mjs`) runs against a mesh on this binding with `MESH_WS_URL` set to
its `amqp://` address. The suite reaches the mesh through the SDK's AMQP transport. The checks that read JetStream
state on the reference binding (c01b's consumer settings, c11's stream limits) check the same thing through what
AMQP shows instead, and say so; a test that exists for one binding only declares it and is reported
`binding-skip` on the other. The agreed results on this binding are `conformance/*/expectations.amqp.json`, and
AgentMesh's CI runs the profile against a mesh on this binding, made from empty by first-run setup, whenever the
binding or what it rests on changes.
