# Two companies, one of them offline

Acme's buyer asks Globex's quoting agent for a price. The two agents belong to
two tenants, which the mesh keeps apart: each tenant's operator decides who
its agents are, and the mesh checks every message's signature.

1. Both agents connect, and the quoting agent registers its `quote` offering.
2. The buyer asks for a price and gets one.
3. The quoting agent goes offline. The buyer asks again anyway.
4. Four seconds later the quoting agent comes back. The request was waiting
   in its mailbox on the mesh; it answers, and the answer reaches the buyer,
   whose request was still open.

The buyer needs no retry logic and no idea whether the other side is up. That
is store and forward.

```sh
node examples/run.mjs nats 01        # or rabbitmq
```

What to read in `run.mjs`: `mesh.onRequest` and `mesh.register` on the
serving side, and `mesh.request(agentId, offering, input, { timeout_ms })` on
the asking side.
