# The kill switch

The mesh's operator can stop an agent at once, wherever it runs.

1. A worker agent is connected and answering.
2. The operator revokes it. This example calls the admin API
   (`POST /admin/v1/credentials/revoke` with the agent's key), which is what
   `mesh-admin credentials revoke --agent <key>` does.
3. The broker closes the worker's connection within seconds, without a
   restart: NATS through its account revocations, RabbitMQ through its
   management API. The example measures the time.
4. The worker's credential no longer connects, and while it is revoked it
   cannot enroll again with a new key either. The operator's view of the
   agent says it is stopped by the operator.
5. The operator restores it (`mesh-admin credentials restore --agent <key>`),
   the worker enrolls again, and it answers as before.

Revoking a whole tenant (`--tenant`) works the same way for every agent the
tenant holds; revoking one connection key (`--key`) cuts that credential only.

```sh
node examples/run.mjs nats 04        # or rabbitmq
```
