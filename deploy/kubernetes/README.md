# The Agent Messaging Server on Kubernetes

Two manifests, one per broker, each the same shape as its Compose setup:

| | |
|---|---|
| [nats/mesh.yaml](nats/mesh.yaml) | NATS JetStream, the server and the A2A gateway |
| [rabbitmq/mesh.yaml](rabbitmq/mesh.yaml) | RabbitMQ, Postgres, the server and the A2A gateway |

```sh
kubectl apply -f nats/mesh.yaml          # or rabbitmq/mesh.yaml
kubectl -n agent-messaging get pods -w
```

## How it starts

1. The `first-run` Job fills the volume `config`: the operator key and the
   signing keys, the broker's settings, the server's settings and the first
   admin token. It runs once; run again on a filled volume, it changes nothing.
2. Every other pod waits in an init container until first-run has written
   `first-run.json`, which it writes last.
3. The broker starts on first-run's settings, then the server, then the
   gateway.

Before the first apply, change the `first-run` ConfigMap's addresses to the
ones your agents will use to reach the cluster (`MESH_NATS_ENDPOINTS` or
`MESH_AMQP_ENDPOINTS`, and `MESH_PUBLIC_URL`). They go into every credential,
and first-run reads them only once.

## One node

Version 1 runs on one node, as the Compose setups do. Every pod mounts the
`config` volume, which is ReadWriteOnce, so the scheduler keeps them together.
The server and the gateway use the `Recreate` strategy, so two servers never
run against one mesh, even during an upgrade. A broker cluster waits until it
has been proven; the [sizing guide](../../docs/sizing.md) says how far one node
goes.

## Reaching it

The manifests make ClusterIP services only: `server` (3005), `nats` (4222,
4443) or `rabbitmq` (5672), and `a2a-gateway` (8090). Expose what your agents
need with your own Ingress, LoadBalancer or Gateway, with TLS. Never expose the
server's admin API (`/admin`) or, on RabbitMQ, the server's port 3006 and
RabbitMQ's management port. A NetworkPolicy in the RabbitMQ manifest lets only
RabbitMQ reach port 3006, where the cluster enforces network policies.

For a quick look from your machine:

```sh
kubectl -n agent-messaging port-forward svc/server 3005:3005
kubectl -n agent-messaging exec deploy/server -- /entrypoint.sh mesh-admin status
```

## Images

The manifests name the released images on ghcr.io. To run a build of your own
on a local cluster, build it from the repository root, load it (`kind load
docker-image`, `k3d image import`) and change the image lines:

```sh
docker build -f server/Dockerfile -t agent-messaging-server:local .
docker build -f a2a-gateway/Dockerfile -t agent-messaging-a2a-gateway:local .
```

## Using a Postgres you already run (RabbitMQ)

Remove the `postgres` StatefulSet and Service, put the database's password in a
Secret, and give both the `first-run` Job and the `server` Deployment
`MESH_POSTGRES_URL` and `MESH_POSTGRES_PASSWORD_FILE` (the Secret mounted as a
file). First-run makes the server's tables there.

## Keep a copy of the operator key

```sh
kubectl -n agent-messaging exec deploy/server -- tar -C /config -cf - keystore > operator-keystore.tar
```

The [operator handbook](../../docs/operator-handbook.md) covers backups,
upgrades, rotating the admin token and revoking agents.
