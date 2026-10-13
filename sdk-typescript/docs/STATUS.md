# TypeScript SDK status

Status as of 2026-10-13, version 0.61.0.

## What it covers

Agent Messaging 0.7 (`conformance/SPEC.md`) and its extensions, on either
binding: NATS, and RabbitMQ over AMQP.

| Area | Status |
|---|---|
| The six primitives: register, discover, request, respond, emit, subscribe | Done. |
| Streaming (SPEC 11.3), the accept signal and queued acknowledgement (6.4a), sender pre-flight (6.4b) | Done. |
| Tasks: the local state machine, deferred answers, cancel with reasons (10.8), budgets (7.7) | Done. |
| Node hosting (many agents on one connection), node vouch renewal (4.4), credential renewal (4.8) | Done. |
| The pre-admission surface (1.5): `describe` (10.14) answered from the manifest's public block and asked with `mesh.describe()`; `knock` (EXT-6 9.3) asked with `mesh.contacts.knock()` | Done. |
| Admission (EXT-6) on the agent's own side: the signed roster, the waiting list, `admit` and `block`, an inbox with `reply` and `dismiss`, the roster kept on the mesh for a guarded inbox | Done. |
| The naming rule, following what the server says it offers; naming (`startNaming`, `verifyNaming`, `completeNaming`); handle resolution with pinning | Done. |
| Inbound protections (SPEC 22): signature, freshness, replay, framing, size cap | Done. |
| Offline mailbox drain (16.4), presence (9.6), durable event subscriptions (18.6) | Done. |
| Rooms (EXT-5): capability, sealed and acl grades, playbooks and phases, the work board | Done. |
| Pairwise sealing (EXT-7), owner allowance (EXT-8) | Done. |
| Feeds, artifacts, storefront proposals, SKUs, agreements, metering | Done. |
| W3C trace context and span publishing | Done. |

## Tests

1,906 unit tests in 90 files: 1,906 pass and 4 skip (the ones that compare
against the reference adapter's source, which is not in this repository).
They include every conformance fixture in `conformance/`. The integration lane
(`npm run test:integration`) needs a live NATS server. The repository's CI
also runs the core conformance profile and every example, the knock, admit
and block example among them, against a server on each broker.

## Not built yet

- Task recovery from the mesh's task record (`mesh.task.get`). A requester that
  loses a stream cannot fetch the result again. The Rust SDK has it.
- The reference adapter's stricter rule for when the naming service does not
  answer (`adapter_outage` in `conformance/naming-gate.json`). The SDK sends
  through, as the platform does.
- Reading or writing an Agent Descriptor.
- Grants on roster entries (EXT-6 6.1): `admit` writes a plain `allow`. A
  guarded inbox on the mesh still applies grants written some other way.

## Publishing

Not on npm yet. Each release is a tarball at
`https://storage.googleapis.com/agentmesh-releases/agent-messaging-<version>.tgz`.
Releases up to 0.58.2 carry the package's old name, `agentmesh-<version>.tgz`.
