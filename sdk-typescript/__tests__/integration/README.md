# Integration lane

Specs here need a live mesh. They skip themselves unless one is pointed at, so
`npm test` stays green without infrastructure.

## rooms-live.test.ts

Covers what the unit lane cannot: durable rooms, replay, the artifact drive, the
`acl` grade, and `sealed` ciphertext-at-rest. Runs in two modes.

### Fully local, all seven cases (what Phase 0 used)

The `acl` grade is the reason this needs setup: it is the only grade enforced by
the BROKER, so it needs an operator → account → user chain and a minting key.
`server/tools/local-acl-mesh.mjs` generates a throwaway one — it never reads
the production account keys and never touches the deployed mesh.

```bash
# 1. Generate an ephemeral operator/account + 16 pre-minted agent credentials
cd services
node tools/local-acl-mesh.mjs /tmp/aclmesh

# 2. A broker that trusts it (JetStream + WebSocket, non-default ports)
docker run -d --name am-acl -p 15222:4222 -p 15443:8080 \
  -v /tmp/aclmesh/nats.conf:/etc/nats/nats.conf \
  nats:2.10-alpine -c /etc/nats/nats.conf

# 3. The rooms + registry services against it. Registry is required: a sealed
#    invite resolves the invitee's encryption key from its registered manifest.
NATS_URL=nats://127.0.0.1:15222 \
NATS_CREDS=/tmp/aclmesh/service.creds \
ROOMS_MINT_SEED_FILE=/tmp/aclmesh/account.nk \
ROOMS_MINT_ISSUER_ACCOUNT=$(node -e "console.log(require('/tmp/aclmesh/env.json').account)") \
ROOMS_REQUIRE_OPERATOR=0 \
npx tsx src/main.ts --service=rooms,registry
# expect: "acl ENABLED · OPERATOR CHECK DISABLED"

# 4. Run
cd ../sdk-typescript
ROOMS_TEST_WS=ws://127.0.0.1:15443 \
ROOMS_TEST_AGENTS=/tmp/aclmesh/agents.json \
npx vitest run --config vitest.integration.config.ts
```

Two env vars, two behaviours:

- `ROOMS_TEST_WS` — local mode. Without `ROOMS_TEST_AGENTS` it connects
  anonymously, which is fine for everything except `acl`.
- `ROOMS_TEST_AGENTS` — the pre-minted credential pool, which also enables the
  `acl` cases. Pre-minted because `nats-jwt` is not an SDK dependency and should
  not become one so a test can mint keys.

### Against the deployed mesh

`AGENTMESH_LIVE=1` makes each agent take a guest lease from
`$AGENTMESH_API` (default `https://api.agentmesh.ai`). **Durable and acl cases
will fail**: provisioning requires an email-verified PAN operator and a guest has
none — the service says so plainly. Only the capability-grade path works this
way. Wiring the full suite into CI needs a pre-provisioned agent with a bound
handle and its seed held as a secret.

## Gotchas that cost real time

- Run exactly **one** rooms service. Several in the same queue group round-robin,
  and only the instance that provisioned a room holds it in memory, so lookups
  fail intermittently with `no such durable room for that descriptor`. On
  Windows, `pkill -f` does not reach node processes — check with
  `Get-CimInstance Win32_Process`.
- `Room.durable`, `.acl`, `.sealed`, `.descriptor` are **getters** in TypeScript
  and **methods** in Rust.
- `RecordEntry` is `{seq, message, envelope}`. `message` is parsed **and
  decrypted** for a key-holding member; `envelope` is the raw stored frame. A
  confidentiality assertion must read `envelope`.
- `FetchedArtifact` carries `data`, not `bytes`.
- An invitee needs a `rooms.invite` handler or the inviter's call throws
  `OFFERING_NOT_FOUND` — the acl admit still happened service-side, which makes the
  failure look unrelated. See `acceptInvites()`.
- The system account must have **no** JetStream storage, or the broker refuses to
  start: `Not allowed to enable JetStream on the system account`.
