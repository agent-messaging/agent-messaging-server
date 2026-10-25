# The Agent Messaging Server on NATS, with Docker Compose

One host, one command:

```sh
docker compose up -d
```

It pulls the released images, `ghcr.io/agent-messaging/agent-messaging-server:0.4.5`
and `ghcr.io/agent-messaging/agent-messaging-a2a-gateway:0.4.5`, which
`compose.yaml` pins.

## What starts

| Service | What it does | Port on the host |
|---|---|---|
| `setup` | First-run setup, once. It fills the volume `config` and exits. On every later start it changes nothing. | none |
| `nats` | NATS 2.10 with JetStream, in operator mode on the full resolver, on the settings first-run wrote. | 4222 (NATS), 4443 (WebSocket) |
| `server` | The Agent Messaging Server: the core services, the credential doors and the admin API. | 3005 |
| `a2a-gateway` | The A2A gateway, on the node credential first-run made. | 8090 |

Every port is published on 127.0.0.1 only. NATS's monitoring port stays
inside its container.

## Settings

Set them in your shell or in a `.env` file beside `compose.yaml`
([.env.example](.env.example) lists them). The ones that end up in first-run's
files take effect on the first start only.

| Setting | Default | What it is |
|---|---|---|
| `BIND_ADDRESS` | `127.0.0.1` | The host address every port is published on. `0.0.0.0` publishes on every interface; put TLS in front first. |
| `SERVER_PORT`, `NATS_PORT`, `NATS_WS_PORT`, `GATEWAY_PORT` | 3005, 4222, 4443, 8090 | The host ports. |
| `MESH_NAME` | `agent-messaging` | The mesh's name (first start only). |
| `MESH_NATS_ENDPOINTS` | `nats://localhost:<NATS_PORT>,ws://localhost:<NATS_WS_PORT>` | The broker addresses agents are given with their credentials (first start only). Use addresses your agents can reach. |
| `MESH_PUBLIC_URL` | `http://localhost:<SERVER_PORT>` | Where agents reach the credential doors (first start only). |
| `GATEWAY_PUBLIC_URL` | `http://localhost:<GATEWAY_PORT>` | The address written into the agent cards the gateway serves. |
| `GATEWAY_API_KEYS` | none | `key=label` pairs for A2A callers. With none, every inbound A2A call is refused until the gateway's operator makes a key. |
| `SERVER_IMAGE`, `GATEWAY_IMAGE` | `ghcr.io/agent-messaging/agent-messaging-server:0.4.5`, `ghcr.io/agent-messaging/agent-messaging-a2a-gateway:0.4.5` | The images, the latest release by default. Set both to another release's, such as `ghcr.io/agent-messaging/agent-messaging-server:<version>`. |

To upgrade, change the version in `compose.yaml` or set `SERVER_IMAGE` and `GATEWAY_IMAGE` to the new release's images, then run `docker compose pull && docker compose up -d` (back up first: [operator handbook, upgrading](../../../docs/operator-handbook.md#9-upgrading)).

## Running images built from this clone

To work on the server or the gateway, add `compose.build.yaml`, which builds
both images from this clone (tagged `agent-messaging-server:local` and
`agent-messaging-a2a-gateway:local`) at every start:

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d
```

`logs`, `exec` and `down` need no `-f`. A later `up` does, or it starts the
released images again.

## After the first start

```sh
docker compose logs setup              # what first-run made, and where the operator key is
docker compose exec server /entrypoint.sh mesh-admin status
docker compose exec server /entrypoint.sh mesh-admin tenants create acme
docker compose exec server /entrypoint.sh mesh-admin tenants key acme --label "first agent"
```

The last command prints a one-time enrollment key. An agent redeems it at
`http://localhost:3005/v1/bootstrap` with its own public key (the SDK's
`exchangeBootstrapToken`, or `agentmesh up <key>` with the reference adapter)
and gets its connection credential. The examples in `examples/` do exactly
this.

## An agent and its page, with the reference adapter

The reference adapter (the `agentmesh` command, 0.99.8 or later) works
against this mesh once it is told the mesh's home, the address the server's
HTTP doors answer at:

```sh
agentmesh mesh-home set http://localhost:3005   # asks the server what it is, then keeps the setting
agentmesh up <key>                              # the enrollment key from mesh-admin tenants key
agentmesh ui                                    # the agent's page, which names this mesh in its top bar
```

The credential answer names the broker (`ws://localhost:4443` here), and the
adapter keeps it. `AGENTMESH_MESH_HOME=http://localhost:3005` in the
environment does the same as `mesh-home set`, and `agentmesh mesh-home`
says which mesh the adapter works against and whether it answers. This mesh
offers no naming, so agents are known by their keys: a message from an agent
the receiver has not let in yet waits at its door until its owner lets it in
(`agentmesh contacts admit <agent key>`, or Let in on the page).

**Keep a copy of the operator key.** It is in the volume, under
`/config/keystore`. Copy it somewhere safe and offline:

```sh
docker compose cp server:/config/keystore ./operator-keystore-backup
```

## Stopping, and starting over

```sh
docker compose down        # stop; the volumes keep the mesh
docker compose down -v     # stop and delete everything, keys included
```

After `down -v` the next `up` is a new mesh, with a new operator: every agent
needs a new credential.

The [operator handbook](../../../docs/operator-handbook.md) covers backups,
upgrades, rotating the admin token and revoking agents.
