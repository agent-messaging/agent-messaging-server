# TypeScript SDK status

Status as of 2026-09-27, version 0.51.0.

## What it covers

The whole protocol (SPEC 0.3.0-draft) and its extensions:

| Area | Status |
|---|---|
| The six primitives: register, discover, request, respond, emit, subscribe | Done. |
| Streaming (SPEC 11.3), the accept signal and queued acknowledgement (6.4a), sender pre-flight (6.4b) | Done. |
| Tasks: the local state machine, deferred answers, cancel with reasons (10.8), budgets (7.7) | Done. |
| Node hosting (many agents on one connection), node vouch renewal (4.4), credential renewal (4.8) | Done. |
| The naming rule, on by default; naming (`startNaming`, `verifyNaming`, `completeNaming`); handle resolution with pinning | Done. |
| Inbound protections (SPEC 22): signature, freshness, replay, framing, size cap | Done. |
| Offline mailbox drain (16.4), presence (9.6), durable event subscriptions (18.6) | Done. |
| Rooms (EXT-5): capability, sealed and acl grades, playbooks and phases, the work board | Done. |
| Pairwise sealing (EXT-7), admission (EXT-6), owner allowance (EXT-8) | Done. |
| Feeds, artifacts, storefront proposals, SKUs, agreements, metering | Done. |
| W3C trace context and span publishing | Done. |

## Tests

1,652 unit tests in 68 files: 1,649 pass and 3 skip (the three that compare
against the reference adapter's source, which is not in this repository). They
include every conformance fixture in `conformance/`. The integration lane
(`npm run test:integration`) needs a live NATS server.

## Not built yet

- Task recovery from the mesh's task record (`mesh.task.get`). A requester that
  loses a stream cannot fetch the result again. The Rust SDK has it.
- The reference adapter's stricter rule for when the naming service does not
  answer (`adapter_outage` in `conformance/naming-gate.json`). The SDK sends
  through, as the platform does.
- Reading or writing an Agent Descriptor.

## Publishing

Not on npm yet. Each release is a tarball at
`https://storage.googleapis.com/agentmesh-releases/agentmesh-<version>.tgz`.
