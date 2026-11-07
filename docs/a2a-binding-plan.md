# Plan: the A2A binding (wire version 0.4.0)

The authority is the binding, `messaging/bindings/a2a.md` in the standards
repository (A2A over Agent Messaging). This plan was written against
0.1.0-draft and is kept current with 0.3.0-draft. Section numbers are the
binding's. It says what changes where in this repository, how the old wire
(0.3.0) and the new one (0.4.0) live side by side, and what is not done yet.

## What changes

Agent Messaging stops having its own task model on the wire. A call between
agents is an A2A operation carried in a `request` frame, and each answer is a
`respond` frame, with the A2A objects (Message, Task, Part, Artifact, the
stream events) in A2A 1.0's JSON form. Frames say `"v": "0.4.0"` and never
carry the envelope fields `task_id`, `context_id`, `budget` or `artifacts`
(§4). The channel's own frames (describe, knock, the probe, the accept
signal, the queued acknowledgement) carry no `a2a` member.

## The SDK (`sdk-typescript/`)

`src/a2a/`:

- `types.ts`: the A2A 1.0 objects, by hand from `a2a.proto`'s JSON form.
- `binding.ts`: the binding URI, the wire version, the operation names,
  frame payloads, the §4 field check, service parameters in `meta.a2a` (§7),
  terminal and interrupted states, stream framing (`streamId`, `seq`,
  `final`, §8), folding events into a Task, `readStreamFrames`, and the
  sealed-frame state reading (§8a).
- `errors.ts`: `A2AError`, the A2A and JSON-RPC error names with their codes,
  and the respond-frame error shape of §9.
- `extensions.ts`: the seven extensions of §12 and helpers for each.
- `readings.ts`: what a client reads under the binding's rules, as the
  conformance fixture pins them (budget blocks and outcomes, cancel and
  failure objects, offering routing, Parts, the wire window, Task snapshots
  from a carrier without subjects).
- `client.ts`: `mesh.a2a.*`, one call per operation.
- `server.ts`: `mesh.a2a.serve(handler)`. The node keeps one change order per
  Task and publishes every change on `mesh.task.{taskId}.update`; each open
  stream gets its own `streamId` and `seq`; reads are answered from the
  task store by relaying the client's signed frame to the task manager, or
  from the node's own copy when no task manager answers.

`mesh.ts` routes a 0.4.0 request carrying `a2a` (or a sealed payload) to the
A2A side after the checks every request gets, and an agent that serves A2A
lists the binding URI in its manifest's `capabilities`.

### 0.3.0 and 0.4.0 together (§14)

- Every 0.3.0 call stays as it is; the docs mark them deprecated.
- The SDK answers each request in the wire version it arrived in, and adapts
  between a 0.4.0 message and a 0.3.0 handler, and the other way.

## The server (`server/`)

- `mesh_a2a_tasks` holds one record per A2A Task id: the Task, unchanged,
  with the requester and responder keys, the engagement, and the Task's place
  in its order of changes beside it (§11).
- The task manager applies 0.4.0 frames on `mesh.task.*.update` to it (0.3.0
  updates still go to the 0.3.0 handler), takes the creating request's
  verified sender and `meta.engagement` from the inbox tap, and answers
  `mesh.task.a2a.get` and `mesh.task.a2a.list` under the access rule of §10.

## The A2A gateway (`a2a-gateway/`)

- For an agent that lists the binding, every operation passes between HTTP
  and frames with no A2A object translated (MAPPING.md §4.0); others keep the
  0.3.0 translation.
- Generated cards list the binding's interface and its extensions.

## Where this implementation differs from the binding, or stops short

- **One store, two buckets.** SPEC.md 0.10 keeps A2A Tasks in `mesh_tasks`.
  This server keeps them in `mesh_a2a_tasks` during the transition window so
  the 0.3.0 records, their sweeps and their readers are untouched.
- **No durable stream behind `mesh.task.*.stream` yet** (§8 "No lost first
  events", SPEC.md §18.3, §18.6). A client therefore reads the Task once with
  `GetTask` after it starts listening, and after a quiet spell, and closes a
  gap with `SubscribeToTask`. A `MESH_TASKS` stream with per-client consumers
  on both brokers, and the credential grants for them, are the follow-up.
- **Subscribe permission per Task** (§8 "Who may listen") is not narrowed:
  the credential templates still grant `sub mesh.task.>`. Narrowing it needs
  grants issued per Task to the nodes that host a reader.
- **The 0.3.0 window has no end switch** on the receiving side yet; the
  `wireRefusal` reading supports one.
- **The mesh home does not serve `/agents/{id}/agent-card.json`** (§3
  SHOULD); the gateway serves cards at its own address.
- **The live conformance runner** (`conformance/run.mjs`) has no binding
  cases; the fixture is checked in the SDK and gateway unit suites.
- Sealed 0.4.0 frames are opened and answered sealed, but a sealed
  `GetTask` cannot be relayed to the task store (the store must read the
  frame), so the node answers it from its own copy.

## Versions

SDK 0.65.1 to 0.66.0, server and gateway 0.4.10 to 0.5.0, with the SDK's
CHANGELOG entry. Nothing is published, tagged or released here.
