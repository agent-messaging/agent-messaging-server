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

## Streams, readers and the 0.3.0 window

- **Durable streams.** `MESH_TASKS` holds `mesh.task.*.stream` and
  `mesh.task.*.update` for seven days: a JetStream stream on NATS, a
  Postgres-backed stream on RabbitMQ (storage/jetstream/tasks-stream.ts,
  storage/postgres/streams.ts). SPEC.md §18.3 lists it as `mesh.task.>`; this
  server leaves out the request subjects (`mesh.task.get.*`,
  `mesh.task.a2a.*`), which a stream would answer with a pub-ack that races
  the service's reply.
- **Who may listen** (SPEC.md §14.3, last paragraph). This server serves each
  stream through a consumer the platform makes only after checking §7.1: the
  client sends `mesh.task.a2a.follow` with its own signed opening frame, the
  task manager checks the frame is the asker's and that the asker created the
  Task, and delivers that stream's frames to the client's inbox from the first
  (task-manager/a2a-follow.ts). It works the same on both brokers and needs no
  credential change while a Task lives. Subscribe grants on `mesh.task.>` stay
  while the 0.3.0 window is open, because 0.3.0 clients read Task subjects
  directly; they go when it closes.
- **The window.** `MESH_WIRE_0_3_0=refuse` (default `accept`) ends it: 0.3.0
  Task updates and reads are refused, and credentials stop granting subscribe
  on `mesh.task.>` (shared/wire-window.ts, operator handbook §16).
- **Cards.** The mesh API serves `/agents/{handle or id}/agent-card.json`
  (registry/agent-card-http.ts).
- **Conformance.** The fixture is read in the SDK and gateway suites, and c26
  in the core profile runs the binding on a live mesh.

## Where this implementation still stops short

- The gateway's generated cards name the agent ID in the binding's interface,
  not the handle (the gateway does not resolve handles); the mesh home's own
  card names the handle.
- MAPPING.md (the A2A Bridge 0.9.1-draft) has the bridge hold a Task of its
  own for a queued acknowledgement on the binding path (§4.3). The gateway
  answers that case with `-32603` and `REQUEST_QUEUED` today.
- Credentials issued before `MESH_WIRE_0_3_0=refuse` keep their Task
  subscribe grants until they are renewed.
- A sealed `GetTask` cannot be relayed to the task store (the store must read
  the frame), so the node answers it from its own copy.

## Versions

SDK 0.65.1 to 0.66.0, server and gateway 0.4.10 to 0.5.0, with the SDK's
CHANGELOG entry. Nothing is published, tagged or released here.
