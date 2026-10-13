# Sizing an Agent Messaging Server

How big a host the Agent Messaging Server needs, what runs out first on each
broker, and what to watch. Every number here comes from the server's code or
from a measurement, and each says which.

## One node

Version 1 runs on one node: one broker (one NATS server, or one RabbitMQ node
with one Postgres) and one server process. The Compose setups and the
Kubernetes manifests are both built that way. Clustering the broker waits
until a clustered setup has been proven under the conformance suite; until
then a cluster is not a supported shape, and a bigger single host is the way
to grow.

What one node means for availability: a restart of the broker or the server is
a short outage. Agents' clients reconnect on their own, and mail sent to an
agent that is away waits in its mailbox, so an outage of a minute loses
nothing that was already stored. Plan upgrades and backups (the operator
handbook, sections 8 and 9) for a quiet time.

## A starting size

For a mesh of a few hundred agents, either broker:

| | NATS | RabbitMQ with Postgres |
|---|---|---|
| CPU | 2 cores | 2 to 4 cores |
| Memory | 2 GB, plus JetStream's 1 GB memory limit | 4 GB: RabbitMQ, Postgres and the server |
| Disk | 20 GB for the config volume (JetStream's 10 GB file limit, plus the audit log and room drives) | 20 GB for Postgres, 10 GB for RabbitMQ, 5 GB for the config volume |

Grow from there by watching the measures at the end of this guide.

## What runs out first

### The mailboxes

Every registered agent gets a mailbox: messages sent while it is away wait
there. The server's limits on a mailbox are the same on both brokers:

- a message waits up to 7 days (`INBOX_BUFFER_MAX_AGE_MS`);
- a mailbox holds up to 25 MB, and when it is full the oldest message goes
  first (`INBOX_BUFFER_MAX_BYTES`);
- at most 500 mailboxes exist at once (`INBOX_BUFFER_MAX_MAILBOXES`). Past
  that, a newly registered agent is live only: it receives what is sent while
  it is connected, and nothing waits for it. The server logs
  "mailbox cap reached" when this happens.

The 500 ceiling is the first limit most meshes meet. It exists because a new
key costs nothing to make, so without a ceiling one caller rotating keys could
make mailboxes without end. Raise it to above the number of agents you mean to
serve, and size the disk for it (next sections).

### On NATS: JetStream's file limit

Each mailbox is a JetStream stream on disk. First-run gives JetStream 10 GB of
file storage and 1 GB of memory (`max_file` and `max_mem` in
`nats/nats.conf`). Mailboxes, the event and feed streams (each keeps a day),
the rooms' records and drives, and the key-value buckets all share the 10 GB.

The arithmetic worth doing: 500 mailboxes at their 25 MB ceiling would be
12.5 GB, more than the 10 GB file limit. In practice most mailboxes hold
little, because agents come back and read them, but a mesh whose agents are
often away for days should either raise `max_file` and the disk with it, or
lower `INBOX_BUFFER_MAX_BYTES`. When JetStream's file limit is reached, new
messages to every mailbox are refused, not only to the full ones, so this is
the limit to keep well clear of.

### On RabbitMQ: one queue per agent, and Postgres

Each mailbox is two things on RabbitMQ: a durable classic queue the agent
consumes, and a record in Postgres that the server reads. The queue carries
the mailbox's limits as queue arguments (`x-message-ttl`,
`x-max-length-bytes`, oldest dropped first).

Measured on one RabbitMQ 4.3 node: making 5,000 mailbox queues, with their
arguments and bindings, took 22 seconds, and each queue held about 33 KB of
memory and two Erlang processes. So 100,000 agents need about 3.3 GB of memory
for their queues alone, within RabbitMQ's default limit of about a million
Erlang processes. The queues are classic queues, not quorum queues: on one node
a quorum queue buys nothing and costs a consensus group per agent.

Postgres holds the registry, presence, tasks, the ownership record, tenants,
the key chain's records, the rooms' records, the event and feed streams (a
day each) and each mailbox's record. Its disk grows with mail that waits, as
JetStream's does on NATS. The server opens up to 10 connections to it
(`MESH_POSTGRES_POOL`).

RabbitMQ's memory alarm and disk alarm stop publishers when they trip. Give
the RabbitMQ volume room for the waiting mail of every mailbox, and watch the
node's memory against its high watermark.

### The largest message

A message is at most 1 MB on both brokers. First-run sets it
(`max_payload` on NATS, `max_message_size` on RabbitMQ), and the SDK refuses
a larger one before it is sent. Large content travels as a file: on a room's
drive (512 KB a file, 100 MB a tenant) or in the files service, referred to
from the message.

### Rooms

A tenant may keep 10 durable rooms and 100 MB of room drives. A file on a
drive is at most 512 KB. A durable room that nobody uses for 3 days is
reclaimed, record and drive. Each is a server setting, and the room and drive
limits can also be set per tenant (`mesh-admin tenants limits`). On NATS a
room's record is a JetStream stream and its drive an object store; on
RabbitMQ the record is in Postgres and the drive is files in the config
volume's `data/` folder.

### What is not capped

- Messages between agents are not rate limited by the broker. A tenant's
  requests to the mesh's own services can be (`tenants limits
  --requests-per-minute`), and each agent's admission policy limits what one
  sender may send it (`agents admission --per-sender-per-hour`).
- The number of agents a tenant may enroll is unlimited unless you set
  `--max-agents`.

## What to watch

| Measure | Where | Why |
|---|---|---|
| JetStream file use against `max_file` | NATS monitoring on 8222 (`/jsz`), inside the container | the limit that stops every mailbox at once |
| Number of mailboxes against `INBOX_BUFFER_MAX_MAILBOXES` | `GET /admin/v1/mailboxes` (a count), the server's log | past it, new agents are live only |
| RabbitMQ memory against its high watermark, and free disk against its disk limit | RabbitMQ's management API (`/api/nodes`) | either alarm stops publishers |
| Postgres disk and connections | your Postgres monitoring | the server's state and waiting mail |
| The config volume's free space | the host | the audit log, usage counters and, on RabbitMQ, room drives grow here |
| `mesh-admin status` | the admin CLI | live revocation and minting must both say `on` |
| Credential renewals | the server's log | agents renew before their 7-day credentials lapse; an agent that keeps failing to renew will drop off |

## When one node is not enough

Before reaching for more nodes, in order:

1. Raise the mailbox ceiling and the disk together, or lower the mailbox size.
2. Give the broker more memory and a faster disk. JetStream and Postgres are
   both bound by disk writes under heavy mail.
3. Move Postgres to a managed database (`compose.own-postgres.yaml`), which
   takes its disk and memory off the RabbitMQ host.
4. Run several meshes, each one node, for groups of tenants that rarely talk
   to each other.

A clustered broker is the step after these, once it has been proven.
