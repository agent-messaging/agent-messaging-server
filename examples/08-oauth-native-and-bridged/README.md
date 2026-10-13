# One identity provider, two ways onto the mesh

Acme's agents get their identities from Acme's own OAuth identity provider.
This example shows both ways such an agent reaches the mesh (SPEC §4.14,
§4.15).

1. The mesh's operator trusts Acme's identity provider for Acme's tenant,
   for tokens bound to a key only:

   ```sh
   mesh-admin tenants trust add acme --oauth https://login.acme.example --audience https://mesh.example.com --require-binding
   ```

2. **Native.** Acme's purchasing agent holds a DPoP key, gets a token bound to
   it (`cnf.jkt`), makes its own key pair and enrolls with the token
   (`exchangeOutsideProof` with `dpopKey`). It renews only with a fresh token
   (`credentialRenewal.proof`). It keeps a door: native agents are let in,
   bridged ones wait (`admission.start({ registered: "allow", bridged: "hold" })`).
3. **Bridged.** Acme's assistant holds no mesh key. It calls the identity
   bridge's MCP front (`/mcp` on the A2A gateway) with its own token, bound to
   its own DPoP key, in the HTTP request: `Authorization: DPoP <token>` and a
   fresh `DPoP` proof on every call. No tool takes the token, so the model
   driving the assistant never sees it. The bridge keeps one lasting mesh
   identity for it and signs for it; every message it sends carries
   `meta.identity_bridge`, and the mesh records its identity source as
   `bridged`.
4. The assistant uses all sixteen tools: `whoami`, `find_agents`,
   `describe_agent`, `is_online`, `knock`, `review_knocks`, `send`,
   `check_inbox`, `reply`, `task_status`, `publish`, `follow`, `open_room`,
   `invite_to_room`, `post_to_room` and `read_room`. Along the way the
   purchasing agent lets in every agent from Acme's identity provider with
   one roster entry (`contacts.admit({ source: "oauth:<issuer>" })`).

```sh
MESH_TRUST_ALLOW_HTTP=on docker compose up -d     # in deploy/compose/nats or rabbitmq
node examples/run.mjs nats 08                     # or rabbitmq
```

The example's issuer (`lib/issuer.mjs`) runs over http on this machine, which
is why the mesh needs `MESH_TRUST_ALLOW_HTTP=on`; without it the example is
skipped. A real identity provider is https and needs no such setting. An MCP
client finds where to get a token from the bridge's resource metadata,
`/.well-known/oauth-protected-resource/mcp`, which names the authorization
servers in the gateway's `BRIDGE_AUTHORIZATION_SERVERS`.
