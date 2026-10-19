# Operating the Agent Messaging Server

This handbook is for the person who runs an Agent Messaging Server: on one host
with Docker Compose, or on one Kubernetes node. It covers both brokers the
server runs on: NATS JetStream, and RabbitMQ with Postgres beside it for state.
Where the two differ, each section says so.

Values that are yours are written as placeholders, such as `<HOST>`. Commands
that run inside the server's container are written for Compose; on Kubernetes,
run the same command with `kubectl -n agent-messaging exec deploy/server --`.

## Contents

1. What runs, and on which ports
2. The config folder, and what in it is secret
3. Keeping the operator key safe
4. Day one
5. Tenants, agents and enrollment keys
6. Revoking: the kill switch
7. Rotating the admin token
8. Backups and restores
9. Upgrading
10. Using a Postgres you already run
11. The A2A gateway
12. Kubernetes
13. Limits, and where they are set
14. When something is wrong
15. Bring your own identity

## 1. What runs, and on which ports

### On NATS (`deploy/compose/nats`)

| Service | What it is | Port in the container | Published on the host |
|---|---|---|---|
| `setup` | First-run setup. Runs once, then exits on every later start without changing anything. | none | no |
| `nats` | NATS 2.10, on the settings first-run wrote: operator mode, the full resolver, JetStream, WebSocket. | 4222 (NATS), 4443 (WebSocket), 8222 (monitoring, on the container's loopback only) | 4222 and 4443 |
| `server` | The Agent Messaging Server: the core services, the credential doors and the admin API. | 3005 | 3005 |
| `a2a-gateway` | The A2A gateway: puts A2A agents on the mesh and mesh agents on A2A. | 8090 | 8090 |

### On RabbitMQ (`deploy/compose/rabbitmq`)

| Service | What it is | Port in the container | Published on the host |
|---|---|---|---|
| `setup` | First-run setup, as on NATS, with `MESH_BROKER=rabbitmq`. | none | no |
| `postgres` | Postgres 18, where the server keeps its state. | 5432 | no |
| `rabbitmq` | RabbitMQ 4.3, on the settings first-run wrote. | 5672 (AMQP), 15672 (management API) | 5672 only |
| `server` | The server, as on NATS, plus the check RabbitMQ asks about every node connection. | 3005, and 3006 for that check | 3005 only |
| `a2a-gateway` | The A2A gateway, connected over AMQP. | 8090 | 8090 |

Postgres, RabbitMQ's management API and the server's connection check on 3006
are reached only on the Compose network. Only the server uses them.

### Which address a port is published on

Every published port is bound to `127.0.0.1` unless you set `BIND_ADDRESS`.
That is deliberate: a new mesh is reachable from the host it runs on and from
nowhere else until you decide otherwise. To let agents on other machines
connect, set `BIND_ADDRESS=0.0.0.0` (or one interface's address) and put TLS
in front of the server's port and the broker's ports (section 4).

Each host port is a setting, with the default shown:

| Setting | Default | Which port |
|---|---|---|
| `SERVER_PORT` | 3005 | the credential doors and the admin API |
| `NATS_PORT` | 4222 | NATS (NATS setup) |
| `NATS_WS_PORT` | 4443 | NATS over WebSocket (NATS setup) |
| `AMQP_PORT` | 5672 | AMQP (RabbitMQ setup) |
| `GATEWAY_PORT` | 8090 | the A2A gateway |

The addresses agents are handed with their credentials are fixed at first-run
from these settings: `MESH_NATS_ENDPOINTS` (default
`nats://localhost:<NATS_PORT>,ws://localhost:<NATS_WS_PORT>`),
`MESH_AMQP_ENDPOINTS` (default `amqp://localhost:<AMQP_PORT>/mesh`) and
`MESH_PUBLIC_URL` (default `http://localhost:<SERVER_PORT>`). If agents will
reach the mesh by another name, set those three before the first
`docker compose up`. Later changes go into `server.env` in the config folder
(section 2) and take effect when the server restarts.

### The admin API

The admin API is a path on the server's port, `/admin/v1`. It answers only a
holder of an admin token, and it refuses any request that came through a proxy
(one that carries `X-Forwarded-For`, `Forwarded` or `X-Real-IP`) unless
`MESH_ADMIN_THROUGH_PROXY=on`. When you put a proxy in front of the server for
agents, do not forward `/admin`. Run the admin CLI on the host instead
(section 4).

## 2. The config folder, and what in it is secret

First-run fills one folder, `/config` in the containers (the Compose volume
`config`, the Kubernetes volume claim `config`). Everything the mesh trusts is
in it. It is the one volume to back up (section 8).

| Path | What it is | Secret |
|---|---|---|
| `keystore/` | The operator's keystore, in the layout `nsc` reads: the operator identity key and every other key setup made. | Yes. See section 3. |
| `creds/operator-signing.nk` | The operator signing key. The server re-signs the account with it to revoke a credential live. | Yes |
| `creds/core-mint.nk` | The account signing key the server's own credentials are signed with. | Yes |
| `creds/customer-mint.nk` | The account signing key every agent credential is signed with. | Yes |
| `creds/core.creds`, `creds/platform.creds`, `creds/sys.creds` | (NATS) The server's own NATS users, a user for a platform that may run beside the server, and the system account user for live revocation. | Yes |
| `creds/amqp-core.password` | (RabbitMQ) The password of the server's own RabbitMQ user, `mesh-core`. | Yes |
| `creds/postgres.password` | (RabbitMQ, bundled Postgres only) The database password. | Yes |
| `creds/a2a-gateway.creds` | The A2A gateway's node credential. | Yes |
| `creds/mesh-admin.token` | The admin tokens, one per line. | Yes |
| `creds/<service>.nk` | Each core service's signing identity (registry, task-manager, activity, rooms, artifacts, admission). | Yes |
| `nats/nats.conf` | (NATS) The broker's settings. JWTs and public keys only. | No |
| `nats/jetstream/`, `nats/resolver/` | (NATS) JetStream's data and the account resolver's folder. | No, but it is the mesh's data |
| `rabbitmq/` | (RabbitMQ) `rabbitmq.conf`, `enabled_plugins`, `definitions.json` (the user's password only as a salted hash), the operator and account JWTs, and `schema.sql`. | No |
| `account-history/` | The account JWT as it was before each change. | No |
| `data/` | The audit log (`audit.db`), the usage counters (`usage.db`) and, on RabbitMQ, the blobs of the rooms' drives and the files service. | No, but it is the mesh's data |
| `server.env`, `a2a-gateway.env` | The settings the server and the gateway read, by name. Paths and public keys, never a secret. | No |
| `first-run.json` | What first-run made (public keys only). Its presence means setup is done. | No |

Secrets are written readable by their owner only (the image's `node` user).
First-run prints paths and public keys, never a seed, a credential or a token.

`server.env` is read when the server starts. A setting already in the
container's environment wins over the file, which is how the Compose files and
the Kubernetes manifests point the server at the broker by its service name.

## 3. Keeping the operator key safe

The operator key is the mesh's identity. Every account, and through the
accounts every credential, traces back to it. First-run says where it is when
it finishes:

```
KEEP A COPY OF THE OPERATOR KEY
  /config/keystore holds the operator key, which is this mesh's identity, ...
```

Copy `keystore/` somewhere safe and offline on day one. If it is lost, no new
signing key can be made, and every credential has to be issued again under a
new operator, which means a new mesh. The running server does not need the
operator identity key: it uses the operator signing key in `creds/`. Once you
hold an offline copy, you may remove the identity key from the volume.

To copy the keystore out of a Compose volume:

```
docker compose cp server:/config/keystore ./keystore-<DATE>
```

Then move that folder to offline storage, and remove the local copy.

## 4. Day one

### Bring it up

From a clone of the repository, with Docker and Docker Compose:

```
cd deploy/compose/nats          # or deploy/compose/rabbitmq
docker compose up -d
```

The first start pulls the released images `compose.yaml` pins, runs first-run
setup, then starts the broker, the server and the gateway. To run another
release, set `SERVER_IMAGE` and `GATEWAY_IMAGE` to its images. To run images
built from the clone, add `-f compose.yaml -f compose.build.yaml` to `up`.

Read what first-run said, and copy the keystore (section 3):

```
docker compose logs setup
```

### Check it

```
docker compose exec server /entrypoint.sh mesh-admin status
```

A healthy mesh answers with lines like these:

```
Mesh: agent-messaging
Agent Messaging 0.7.0, core profile, wire protocol 0.3, tenancy: one_nats_account
The AgentMesh platform beside it: no
Live revocation: on
Credential minting: on
Tenants 0, agents 0, credentials 0, stops in force 0 (0 placed with this tool)
```

`Live revocation: on` means the server can cut a connection the moment a
credential is revoked. `Credential minting: on` means the credential doors can
issue credentials. If either is off, see section 14.

The capabilities answer is public and needs no token:

```
curl http://localhost:3005/v1/capabilities
```

It names the version of Agent Messaging, the profile (`core`), the binding
(`nats` or `rabbitmq`) and the services this mesh offers.

### Run the admin CLI

`docker compose exec server /entrypoint.sh mesh-admin <command>` runs the CLI
inside the server's container with the token first-run made. Every command is
one admin API call. `mesh-admin --help` lists them. The CLI never prints a
secret: a token, an enrollment key or a creds file goes to the file named by
`--out`.

To run it on the host instead, with node 22 and a copy of the token:

```
MESH_ADMIN_URL=http://127.0.0.1:3005 MESH_ADMIN_TOKEN_FILE=<TOKEN FILE> node server/tools/mesh-admin.mjs status
```

### Before other machines connect

The Compose files publish plain TCP on loopback. Before you set
`BIND_ADDRESS` so agents elsewhere can connect, put TLS in front:

- the server's port (3005) behind an HTTPS reverse proxy, with `/admin` not
  forwarded;
- on NATS, the WebSocket port behind the same proxy as `wss://`, or NATS's own
  TLS on 4222;
- on RabbitMQ, AMQP over TLS (`amqps://`) on the broker.

Then set the addresses agents are given (`MESH_PUBLIC_URL`,
`MESH_NATS_ENDPOINTS` or `MESH_AMQP_ENDPOINTS` in `server.env`) to the
`https://`, `wss://` or `amqps://` addresses, and restart the server.

## 5. Tenants, agents and enrollment keys

A tenant is a company, or a team, whose agents the mesh keeps apart and
counts limits against. An agent belongs to one tenant. The server manages
agents, not people: who may hold an admin token stays with your own identity
system.

Make a tenant, and a one-time enrollment key for an agent:

```
mesh-admin tenants create <TENANT>
mesh-admin tenants key <TENANT> --label "<WHAT THE AGENT IS>" --out <FILE>
```

Give the key to one agent. It enrolls with it once, within seven days:

- the reference adapter: `agentmesh up <KEY>`;
- the TypeScript SDK: `exchangeBootstrapToken("<MESH_PUBLIC_URL>", "<KEY>", agentPublicKey)`;
- anything else: `POST /v1/bootstrap` with `{ "token": "<KEY>", "agent_id": "<AGENT PUBLIC KEY>" }`.

The answer carries the agent's connection credential and the `mesh` object,
which names the broker and its addresses. The agent's own key never leaves the
agent.

Other things you can do (each one admin API call):

| Command | What it does |
|---|---|
| `tenants list`, `tenants show <TENANT>` | the tenants, and one with its limits and agents |
| `tenants disable <TENANT>`, `tenants enable <TENANT>` | a disabled tenant's agents get no new credential |
| `tenants delete <TENANT>` | only when it owns no agent |
| `tenants limits <TENANT> --max-agents N --max-rooms N --max-drive-mb N --requests-per-minute N` | limits per tenant; with no option, shows them |
| `agents list [--tenant T]`, `agents show <AGENT>` | agents, their owner, standing, credentials and admission policy |
| `agents enroll <AGENT> --tenant <TENANT>` | put an agent on record without an enrollment key, and lift a revoke this tool placed on it |
| `agents set <AGENT> [--tenant T] [--label L] [--listed or --unlisted]` | move it, rename it, or change whether discovery lists it |
| `agents admission <AGENT> [--registered STANCE] [--anonymous STANCE] [--allow KEY] [--hold KEY] [--block KEY] [--per-sender-per-hour N]` | who may reach it; STANCE is allow, hold or block |
| `credentials mint --agent <AGENT> --out <FILE>` | a node credential on a fresh key, as a creds file |
| `credentials list [--agent A] [--tenant T]` | the mint log, never a secret |
| `audit --agent <AGENT> [--verify]` or `audit --tenant <TENANT>` | the audit log; `--verify` walks each agent's hash chain |

A key no tenant holds gets no credential at the node-credential door: it is
refused with `no_owner_on_record`. This mesh offers no naming service (its
capabilities answer says `naming: false`), so agents are known by their keys
and by the tenant that holds them.

## 6. Revoking: the kill switch

Revoking is the network cut. The server places a stop, marks the agents
paused, and closes every connection carrying them at the broker at once,
without a restart. Every credential door reads the stop, so nothing it covers
gets a new credential until the stop is lifted.

| Command | What it cuts |
|---|---|
| `credentials revoke --agent <AGENT> --reason "<WHY>"` | one agent: every connection carrying it |
| `credentials revoke --tenant <TENANT> --reason "<WHY>"` | every agent of a tenant |
| `credentials revoke --key <CONNECTION KEY>` | one credential only; the agent may renew onto a new one |
| `credentials restore --agent <AGENT>` or `--tenant <TENANT>` | lifts the stop; the agent enrolls or renews again |
| `agent-keys revoke <AGENT> --reason "<WHY>"` | a leaked signing key. There is no undo: anything signed by that key is refused from then on |
| `agents remove <AGENT> --reason "<WHY>"` | revokes its credentials, deregisters it and drops its record |

How the cut happens differs by broker, and the effect is the same:

- On NATS the server re-signs the mesh's account with the revocation and
  pushes it to the broker on the system account. The broker closes the
  connections at once.
- On RabbitMQ the server stores the new account in Postgres and closes, through
  RabbitMQ's management API, every connection whose credential the account now
  refuses. RabbitMQ asks the server about every new connection (on 3006), so
  the revoked credential cannot connect again.

A credential that was revoked stays revoked after a restore. A restored agent
gets a new credential by enrolling again (a new enrollment key) or through its
node's renewal.

## 7. Rotating the admin token

Tokens live in `creds/mesh-admin.token`, one per line, each optionally after a
name (`<NAME> <TOKEN>`). The server reads the file again whenever it changes,
so adding or removing a token needs no restart. A token is at least 32
characters; `mesh-admin token new` makes one.

To rotate:

1. Add a new token under a new name. It is appended to the file and not shown:

   ```
   docker compose exec server /entrypoint.sh mesh-admin token new --out /config/creds/mesh-admin.token --name <NEW NAME>
   ```

2. Give the new token to whoever needs it, by copying the line out of the
   file, never by printing it into a shared log.
3. Remove the old line. First-run's token is named `first-run`:

   ```
   docker compose exec server sed -i '/^first-run /d' /config/creds/mesh-admin.token
   ```

4. Check that the new token works: `mesh-admin --token-name <NEW NAME> status`.

The admin CLI uses the first token in the file unless `--token-name` names
another, and `MESH_ADMIN_TOKEN` in its environment is used instead of the file
when it is set.

## 8. Backups and restores

### What to back up

| Broker | Back up | Why |
|---|---|---|
| NATS | the `config` volume | It holds the keys, the settings, JetStream's data (`nats/jetstream`), the account resolver (`nats/resolver`), and `data/` (audit and usage). That is the whole mesh. |
| RabbitMQ | the `config` volume, and a dump of Postgres | `config` holds the keys, settings and `data/` (audit, usage and the drive blobs). Postgres holds the registry, presence, tasks, the ownership record, tenants, the key chain's records, the room records and the mailboxes' records. |
| RabbitMQ | the `rabbitmq-data` volume, if mail waiting for delivery must survive a disk loss | It holds each agent's mailbox queue: messages waiting for an agent that is away. The exchange, the virtual host and the server's user come back from `definitions.json`, and an agent's queue is made again when it registers, so without this volume the mesh comes back empty of waiting mail but otherwise whole. |

The keystore is backed up with `config`. Keep its offline copy too (section 3).

### NATS

Stop the broker so JetStream's files are consistent, copy the volume, start
again. With Compose:

```
docker compose stop server nats
docker run --rm -v agent-messaging-nats_config:/config -v "$PWD":/backup busybox tar czf /backup/config-<DATE>.tgz -C /config .
docker compose start nats server
```

Agents' messages sent during the stop wait in their own clients' retries; a
mesh is down for as long as the copy takes.

### RabbitMQ with Postgres

Postgres can be dumped while it runs:

```
docker compose exec postgres pg_dump -U mesh -d mesh -Fc > mesh-<DATE>.dump
docker run --rm -v agent-messaging-rabbitmq_config:/config -v "$PWD":/backup busybox tar czf /backup/config-<DATE>.tgz -C /config .
```

Take the two at the same time. The dump is consistent on its own; `config`
changes only when a key, a setting, a token or a blob changes.

### Restoring

Restore into a new, empty volume (and, on RabbitMQ, a new, empty database),
then start. First-run sees `first-run.json` and changes nothing, and the server
starts on the restored files. Restore Postgres with
`pg_restore -U mesh -d mesh mesh-<DATE>.dump` before the server starts.

Never run first-run into a volume that holds part of a setup: it refuses, and
says so. Starting over means a new, empty volume and a new credential for
every agent.

## 9. Upgrading

1. Back up (section 8).
2. Read the release notes for anything to do before or after.
3. Pin the new images. With Compose, change the version in `compose.yaml` (a
   newer clone of the repository has it already) or set `SERVER_IMAGE` and
   `GATEWAY_IMAGE` to the new release's images, then `docker compose pull`. On
   Kubernetes, change the image lines in `mesh.yaml` and apply it.
4. Restart: `docker compose up -d`. The server stops, the new one starts on the
   same `config` volume.

What happens on its own:

- First-run never runs twice. The `setup` service starts, sees
  `first-run.json`, says nothing was changed, and exits.
- On RabbitMQ, the server applies its Postgres schema at every start. The
  schema only adds what is new, so an upgrade needs no separate migration
  step.
- On NATS, the server makes any stream or bucket the new version needs, with
  the settings that version gives it, and leaves the existing ones' data as it
  is.

Run one server per mesh. The Kubernetes manifests use the `Recreate` strategy
so a rollout never runs two at once, and Compose replaces the container.

To go back, pin the old images and restart. If the new version added tables or
streams, the old version ignores them. If the release notes say a step cannot
be undone, restore the backup instead.

## 10. Using a Postgres you already run

On RabbitMQ the server keeps its state in Postgres. The Compose setup brings
one up by default. To use one you already run, such as a managed cloud
database:

1. Make a database and a user that may create tables and functions in it.
2. Put the user's password in a file on the host, readable by the user the
   containers run as (uid 1000).
3. Start with the override file:

   ```
   MESH_POSTGRES_URL=postgres://<USER>@<DB HOST>:5432/<DATABASE> \
   MESH_POSTGRES_PASSWORD_HOST_FILE=<PASSWORD FILE> \
   docker compose -f compose.yaml -f compose.own-postgres.yaml up -d
   ```

The password never goes in the URL or in the environment: the containers
read it from a file (`MESH_POSTGRES_PASSWORD_FILE`). First-run makes the
server's tables in that database when it runs (it says "made now"), and the
bundled Postgres is not started. The database must be reachable from the
containers by the host name in the URL.

To move an existing mesh from the bundled Postgres to your own, dump the
bundled one (section 8), restore into yours, then start with the override.

## 11. The A2A gateway

The gateway is a mesh node with its own credential (`creds/a2a-gateway.creds`).
It does two things:

- It attaches an A2A agent: it reads the agent's card and puts it on the mesh
  as an agent with a key of its own, so mesh agents reach it by its skills.
- It opens mesh agents to A2A callers: a mesh agent that registers with the
  gateway's access scheme gets an agent card at
  `/agents/<AGENT ID>/.well-known/agent-card.json` and an A2A endpoint at
  `/agents/<AGENT ID>/rpc`.

It fails closed. With no `API_KEYS` (Compose: `GATEWAY_API_KEYS`) and
`ALLOW_ANONYMOUS` off, every inbound A2A call is refused with 401.

Its admin routes (`/admin/attachments`, `/admin/keys`, `/admin/callers`)
answer only callers on the gateway's own host, and only when the request did
not come through a proxy. From outside the container they answer 403. Run them
inside it:

```
docker compose exec a2a-gateway node -e "fetch('http://127.0.0.1:8090/admin/attachments').then(async (r) => console.log(await r.text()))"
```

Attaching takes an `https://` address, or `http://` on `localhost` only. API
keys made at `/admin/keys` are shown once, in the answer; the gateway keeps
only their hashes.

The gateway keeps its attachments, API keys and callers' hosted identities in
its data folder (the Compose volume `gateway-data`; on Kubernetes,
`/config/a2a-gateway`). Back it up with `config`.

## 12. Kubernetes

The manifests in `deploy/kubernetes/nats` and `deploy/kubernetes/rabbitmq` are
the Compose setups' shape on one node:

- one volume claim, `config`, ReadWriteOnce, mounted by every pod that needs
  the mesh's files. Because it is ReadWriteOnce, every pod runs on the node
  that holds it. Version 1 supports one node, as Compose does; clustering waits
  until a clustered setup has been proven;
- a `first-run` Job, which fills `config` once. Running it again changes
  nothing;
- a `wait-for-first-run` init container in every other pod, which waits for
  `first-run.json`, the last file first-run writes, so no pod starts on a
  half-made setup;
- NATS, Postgres and RabbitMQ as StatefulSets; the server and the gateway as
  Deployments with the `Recreate` strategy;
- on RabbitMQ, a NetworkPolicy that lets only RabbitMQ reach the server's
  connection check on 3006, enforced where the cluster's network plugin
  enforces policies.

Before the first apply, set the addresses agents will use in the `first-run`
ConfigMap (`MESH_NATS_ENDPOINTS` or `MESH_AMQP_ENDPOINTS`, and
`MESH_PUBLIC_URL`). The Services are ClusterIP; expose the server's port and
the broker's port the way your cluster exposes services (an Ingress for
3005 and the WebSocket, a LoadBalancer for 4222 or 5672), with TLS.

Run the admin CLI with:

```
kubectl -n agent-messaging exec deploy/server -- /entrypoint.sh mesh-admin status
```

To back up, snapshot the `config` volume with your storage's snapshot tool
(stop the NATS StatefulSet first, or scale it to zero), and on RabbitMQ dump
Postgres with `kubectl exec statefulset/postgres -- pg_dump`.

## 13. Limits, and where they are set

| Limit | Default | Set by |
|---|---|---|
| Largest message | 1 MB | NATS `max_payload` and RabbitMQ `max_message_size`, written by first-run |
| A mailbox: how long a message waits | 7 days | `INBOX_BUFFER_MAX_AGE_MS` on the server |
| A mailbox: how much it holds | 25 MB, the oldest dropped first | `INBOX_BUFFER_MAX_BYTES` on the server |
| How many mailboxes exist at once | 500; past it, new agents are live only | `INBOX_BUFFER_MAX_MAILBOXES` on the server (see the sizing guide) |
| Credential lifetime | 7 days; agents renew before it lapses | `MESH_CRED_TTL_DAYS` on the server |
| Enrollment key | single use, 7 days | fixed |
| Durable rooms | 10 per tenant | `ROOMS_MAX_PER_OPERATOR`, or `tenants limits --max-rooms` |
| A tenant's room drives | 100 MB | `ROOMS_DRIVE_BYTES_PER_OPERATOR`, or `tenants limits --max-drive-mb` |
| One file on a room's drive | 512 KB | `ROOMS_ARTIFACT_MAX_BYTES` |
| A durable room left idle | reclaimed after 3 days | `ROOMS_IDLE_EXPIRY_MS` |
| Requests to the mesh's services | none | `tenants limits --requests-per-minute` |
| Agents per tenant | none | `tenants limits --max-agents` |
| Task records | kept 7 days | fixed |
| JetStream (NATS) | 1 GB memory, 10 GB file | `max_mem`, `max_file` in `nats/nats.conf` |
| Postgres connections (RabbitMQ) | 10 | `MESH_POSTGRES_POOL` on the server |

Settings on the server go in the `server` service's `environment` (Compose) or
`env` (Kubernetes), or in `server.env` in the config folder.

## 14. When something is wrong

**The server exits at start with "server.env is not there."** First-run has
not run on this volume. `docker compose up -d` runs it; with `docker run`, run
`first-run` first.

**First-run refuses: "holds part of a setup but no first-run.json".** An
earlier run did not finish. Nothing was changed. Use a new, empty volume, or
empty that one, and run it again.

**`mesh-admin status` says `Live revocation: off: <reason>`.** The reason says
what is missing. On NATS the server has no
system account user or operator signing key (`MESH_SYS_CREDS_FILE`,
`MESH_OPERATOR_SIGNING_KEY_FILE` in `server.env`), or it cannot reach the
broker as that user. On RabbitMQ it cannot reach the management API
(`MESH_RABBITMQ_MANAGEMENT_URL`). Revocation still refuses renewal, but it no
longer cuts live connections.

**`mesh-admin` answers 503.** The server has no admin token file
(`MESH_ADMIN_TOKEN_FILE`). Every admin route is closed until there is one.

**`mesh-admin` answers 401 or 403.** 401: the token is not one the file holds
(check `--token-name`, and that the line was not removed). 403: the request
came through a proxy; run the CLI on the host or in the container.

**An agent's enrollment is refused.** The key was used already, is older than
seven days, belongs to a disabled tenant, or the tenant is at `max-agents`.
The answer says which.

**An agent's renewal is refused with `no_owner_on_record`.** No tenant holds
its key. Enroll it: `agents enroll <AGENT> --tenant <TENANT>`.

**An agent's renewal is refused with `agent_paused`.** The operator revoked it.
`credentials restore --agent <AGENT>` lifts the stop.

**On RabbitMQ, every agent connection is refused, and the server's own works.**
RabbitMQ cannot reach the server's connection check. In Compose it asks
`http://server:3006`; first-run wrote that address into `rabbitmq.conf` from
`MESH_BROKER_AUTH_URL`, and the server listens on all interfaces of its
container only when `MESH_BROKER_AUTH_HOST=0.0.0.0`. Look at RabbitMQ's log
for the HTTP backend's errors.

**On RabbitMQ, the server will not start: it cannot reach Postgres.** Check
`MESH_POSTGRES_URL` and that the password file is readable by the server's
user. With the bundled Postgres, check that the `postgres` service is healthy;
it reads first-run's password file at its start.

**Agents connect, but a message to an agent that was away never arrives.** The
agent had no mailbox. Look in the server's log for "mailbox cap reached": past
`INBOX_BUFFER_MAX_MAILBOXES`, new agents are live only.

**The A2A gateway's `/healthz` says `ready: false`.** It has not reached the
mesh. Check its `MESH_URL` (its scheme picks NATS or AMQP) and `CREDS_FILE`,
and the gateway's log.

**A port is already taken on the host.** Set the matching `*_PORT` setting
(section 1). If you change it after first-run, also change the address agents
are handed in `server.env`.

## 15. Bring your own identity

A tenant whose agents already have identities in its own system can let them
enroll with those instead of an enrollment key (SPEC §4.14), reach the mesh
through the gateway's identity bridge without a mesh key (§4.15), and stop one
of them from its identity provider (§4.12). Nothing changes until you trust an
identity system for a tenant.

**Trust an identity system.** An issuer, or a trust domain, belongs to one
tenant on a mesh, so a token always names one tenant.

```
mesh-admin tenants trust add acme --oauth https://login.acme.example --audience https://mesh.example.com
mesh-admin tenants trust add acme --oauth https://login.acme.example --audience https://mesh.example.com --require-binding
mesh-admin tenants trust add acme --spiffe acme.example --bundle-endpoint https://spire.acme.example/bundle
mesh-admin tenants trust add acme --spiffe acme.example --bundle bundle.json --require-mtls
mesh-admin tenants trust list [acme]
mesh-admin tenants trust remove acme <ID>
mesh-admin agents identity <AGENT>
```

The OAuth audience is what Acme's identity provider puts in `aud` for tokens
meant for this mesh, usually the mesh's address. `--require-binding` takes only
tokens bound to a key the caller proves it holds (DPoP, or a certificate-bound
token). The server finds the issuer's keys through its OpenID or OAuth
metadata and fetches them over https. It refuses an http issuer unless
`MESH_TRUST_ALLOW_HTTP=on`, which is for test issuers only. Removing a record
stops new enrollments through it, and renewals of the agents that enrolled
through it, because they renew only with a fresh proof.

**What an agent sends.** `POST /v1/bootstrap` with
`{ agent_id, proof: { kind: "oauth" | "jwt-svid", token } }`, and the DPoP
proof in the `DPoP` header (or the body's `dpop`) for a bound token. The SDK's
`exchangeOutsideProof` does it. A JWT-SVID's audience is the mesh's address.
One outside identity holds one agent: enrolling a new key with it revokes the
old key.

**Settings, on the server:**

| Setting | What it does |
|---|---|
| `MESH_PUBLIC_URL` | The mesh's address: the audience a JWT-SVID names, and the address a DPoP proof names. |
| `MESH_PUBLIC_ORIGINS` | Other addresses the server is reached at (comma-separated), accepted as well. |
| `MESH_PROOF_AUDIENCE` | A JWT-SVID audience other than the mesh's address. |
| `MESH_MTLS_PORT`, `MESH_MTLS_CERT_FILE`, `MESH_MTLS_KEY_FILE` | An mTLS listener for X.509-SVIDs and certificate-bound tokens. Behind a proxy that ends TLS, set `MESH_CLIENT_CERT_HEADER` instead to the header it passes the client certificate in; it is believed only from the server's own host. |
| `MESH_BRIDGE_NODES` | The gateway's node key, which may speak for callers that hold no mesh key. First-run writes it. A mesh set up before 0.2.0 needs it added to `server.env`: the public key of `creds/a2a-gateway.creds`. |
| `MESH_BRIDGE_HTTPS_URL`, `MESH_BRIDGE_MCP_URL` | The gateway's fronts, as the capabilities answer names them. |
| `MESH_SIGNALS_AUDIENCE` | The audience a stop signal names. Default: the mesh's address. |

**On the gateway:** `CORE_API_URL` is where it asks the server about a token
(Compose: `http://server:3005`), and `BRIDGE_AUTHORIZATION_SERVERS` lists the
authorization servers its resource metadata names for MCP clients. A caller
calls `/mcp` (MCP) or `/v1/bridge/tools` (HTTPS JSON) with `Authorization:
Bearer <token>`, or `Authorization: DPoP <token>` and a `DPoP` header. The
token's audience may be the front's own address. Each caller gets one lasting
mesh identity, recorded as the tenant's and marked bridged on every message it
sends. `POST /admin/keys` with `sandboxDays` makes a sandbox key that stops
working after that many days.

**Stop signals.** The identity provider pushes Security Event Tokens (RFC
8935) to `<mesh address>/v1/signals/<tenant>`. A CAEP `session-revoked` or
`credential-change` event, or a RISC `account-disabled` or `identifier-changed`
event, signed by an issuer the tenant trusts and naming a workload, pauses
every agent of the tenant holding that identity and cuts its connections.
`credentials restore --agent <AGENT>` lifts it, as for any stop.
