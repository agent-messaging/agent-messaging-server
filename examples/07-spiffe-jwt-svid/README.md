# An agent enrolls with its SPIFFE identity

Acme runs SPIRE, so its workloads already have SPIFFE identities. Its agent
joins the mesh with the JWT-SVID SPIRE gives it, in place of an enrollment key
from the mesh's operator (SPEC §4.14).

1. A SPIRE server is the authority of the trust domain `example.org`
   (`compose.yaml` in this folder; the example starts and stops it).
2. The mesh's operator trusts that trust domain for Acme's tenant, with
   SPIRE's trust bundle:

   ```sh
   mesh-admin tenants trust add acme --spiffe example.org --bundle bundle.json
   ```

   or `--bundle-endpoint URL` where the bundle is published. A trust domain
   belongs to one tenant on a mesh.
3. SPIRE mints a JWT-SVID for `spiffe://example.org/agents/buyer`, with the
   mesh's address as its audience.
4. The agent makes its own key pair and enrolls with the SVID
   (`exchangeOutsideProof(meshApi, publicKey, { kind: "jwt-svid", token })`).
   It gets a credential like any other, and signs everything it sends with
   its own key.
5. The mesh records where its identity came from, as an attestation it
   signs (`identity_source`, SPEC §9.7). Another agent finds it with
   `discover({ identity_source: { kind: "spiffe", trust_domain: "example.org" } })`
   and reads it in `describe`. What the agent's own registration claims is
   ignored.

```sh
node examples/run.mjs nats 07        # or rabbitmq
```

An agent enrolled this way renews only with a fresh SVID: pass
`credentialRenewal.proof` to `AgentMesh.connect`, a function that returns a
new one. A workload SPIRE no longer issues SVIDs for stops at its next renewal.
