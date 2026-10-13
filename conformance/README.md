# Conformance: the core profile

This folder holds the conformance suite's core profile: the tests every Agent
Messaging server must pass (the specification's §1.6), and the specification
they test, `SPEC.md`, as published at https://agentmessaging.ai. The whole
suite, with the profiles for deployment-defined parts and for naming
registrars, is published with the specification at
https://github.com/jeffrschneider/agent-messaging.

| | |
|---|---|
| `run.mjs` | The runner: one board for one profile, the core profile by default. |
| `core/tests/`, `peering/tests/` | The tests. Each declares its profile; only core tests are here. |
| `core/expectations.json`, `peering/expectations.json` | What each test does on a NATS mesh. `--ci` fails on a regression against them. |
| `*/expectations.amqp.json` | The same, on a RabbitMQ mesh. |
| `*.json` (this folder) | Test vectors the SDK's tests read: canonical JSON, signatures, delegation and the rest. |
| `reference-adapter.json` | The released reference adapter the adapter tests (c12, c13, c15) and the suite's own echo agent run, pinned by URL and SHA-256. `tools/conformance.mjs install` installs it, and the runner finds it through `RESOLVER_MJS`. |

## Running it

Against a Compose setup of this repository, from the repository root:

```sh
node tools/conformance.mjs install
node tools/conformance.mjs nats          # or rabbitmq
node tools/conformance.mjs nats --ci     # fail on a regression, as CI does
```

`tools/conformance.mjs` takes the admin token and a node credential out of the
server's config volume, puts the suite's own identity on record under a
tenant, and runs `run.mjs` against the mesh, with this repository's SDK as the
SDK under test. Against any other server, set what `run.mjs` reads yourself:

| Setting | What it is |
|---|---|
| `MESH_WS_URL` | The broker address: `ws://…` on NATS, `amqp://…/<vhost>` on RabbitMQ. Its scheme picks the binding. |
| `MESH_CREDS_FILE` | A node credential (a creds file) the suite's agents connect with. |
| `MESH_IDENTITY_FILE` | The suite's own identity (`{ public_key, seed }`), which the mesh's operator has put on record under a tenant. |
| `STOREFRONT_BASE` | The server's HTTP address (the credential doors). |
| `MESH_ADMIN_URL`, `MESH_ADMIN_TOKEN_FILE` | The admin API, with which the adapter tests enroll the adapter's fresh key on a mesh that offers no naming. |
| `AGENTMESH_SDK` | A built SDK folder to test instead of the published one. |
| `RESOLVER_MJS` | The reference adapter's `mesh-adapter.mjs`, for the adapter tests and the echo agent. |

The runner prints the specification version, the profile and the binding it
tested.
