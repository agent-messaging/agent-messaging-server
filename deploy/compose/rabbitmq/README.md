# The Agent Messaging Server on RabbitMQ and Postgres, with Docker Compose

One host, one command:

```sh
docker compose up -d
```

It pulls the released images, `ghcr.io/agent-messaging/agent-messaging-server:0.3.1`
and `ghcr.io/agent-messaging/agent-messaging-a2a-gateway:0.3.1`, which
`compose.yaml` pins.

## What starts

| Service | What it does | Port on the host |
|---|---|---|
| `setup` | First-run setup, once. It fills the volume `config` and exits. On every later start it changes nothing. | none |
| `postgres` | Postgres 18, where the server keeps its state. Its password is the one first-run made. | none |
| `rabbitmq` | RabbitMQ 4.3 on the settings first-run wrote: the mesh's virtual host and topic exchange, the server's own user, and the check that asks the server about every other connection. | 5672 (AMQP) |
| `server` | The Agent Messaging Server: the core services, the credential doors, the admin API, and the check RabbitMQ asks (port 3006, on the Compose network only). | 3005 |
| `a2a-gateway` | The A2A gateway, over AMQP, on the node credential first-run made. | 8090 |

Every port is published on 127.0.0.1 only. Postgres and RabbitMQ's management
API are not published: only the server uses them.

## Settings

As for NATS ([.env.example](.env.example) lists them): `BIND_ADDRESS`,
`SERVER_PORT`, `AMQP_PORT` (5672), `GATEWAY_PORT`, `MESH_NAME`,
`MESH_AMQP_ENDPOINTS` (the broker addresses agents are given, default
`amqp://localhost:<AMQP_PORT>/mesh`), `MESH_PUBLIC_URL`, `GATEWAY_PUBLIC_URL`,
`GATEWAY_API_KEYS`, `SERVER_IMAGE` and `GATEWAY_IMAGE` (the images, by default
the latest release, `ghcr.io/agent-messaging/agent-messaging-server:0.3.1` and
`ghcr.io/agent-messaging/agent-messaging-a2a-gateway:0.3.1`).

To upgrade, change the version in `compose.yaml` or set `SERVER_IMAGE` and `GATEWAY_IMAGE` to the new release's images, then run `docker compose pull && docker compose up -d` (back up first: [operator handbook, upgrading](../../../docs/operator-handbook.md#9-upgrading)).

## Using a Postgres you already run

The bundled Postgres is only the default. To keep the server's state in a
database you already run, such as a managed cloud database, put its password
in a file on this host and start with the second Compose file:

```sh
printf '%s\n' '<the password>' > postgres.password
export MESH_POSTGRES_URL=postgres://<user>@<host>:5432/<database>
export MESH_POSTGRES_PASSWORD_HOST_FILE=./postgres.password
docker compose -f compose.yaml -f compose.own-postgres.yaml up -d
```

The password is never part of the URL or the environment. First-run makes the
server's tables in that database (they are named `ams_*`), so the user needs
the right to create tables and functions there. The server applies the same
schema at every start, which adds only what a new release brings. The bundled
Postgres is not started, and its volume stays empty.

## Running images built from this clone

To work on the server or the gateway, add `compose.build.yaml`, which builds
both images from this clone (tagged `agent-messaging-server:local` and
`agent-messaging-a2a-gateway:local`) at every start:

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d
```

`logs`, `exec` and `down` need no `-f`. A later `up` does, or it starts the
released images again. With your own Postgres, add `-f compose.own-postgres.yaml`
after the other two.

## After the first start

```sh
docker compose logs setup              # what first-run made, and where the operator key is
docker compose exec server /entrypoint.sh mesh-admin status
docker compose exec server /entrypoint.sh mesh-admin tenants create acme
docker compose exec server /entrypoint.sh mesh-admin tenants key acme --label "first agent"
```

An agent redeems the enrollment key at `http://localhost:3005/v1/bootstrap`.
The credential answer names the broker (`amqp://localhost:5672/mesh`), and the
SDK picks its AMQP transport from it, so agent code is the same as on NATS.

**Keep a copy of the operator key** (`/config/keystore` in the volume), and back
up Postgres with the volume: the [operator
handbook](../../../docs/operator-handbook.md) says how.

## Stopping, and starting over

```sh
docker compose down        # stop; the volumes keep the mesh
docker compose down -v     # stop and delete everything: keys, database, queues
```
