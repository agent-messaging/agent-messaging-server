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
- **The bridge's own Tasks.** When an agent's node queues a binding request,
  the gateway answers the HTTP caller with a Task it holds, as the A2A Bridge
  §4.3 says (a2a-gateway/src/inbound/binding-held.ts); the SDK hands the
  agent's later answer to `onLateAnswer`. The gateway's generated cards take
  the binding interface URL from the mesh home's own card, so they name the
  handle the naming service confirms.
- **Conformance.** The fixture is read in the SDK and gateway suites, and c26
  in the core profile runs the binding on a live mesh.

## What a platform reads from an A2A Task (server 0.5.1)

Server 0.5.0 stored A2A Tasks, but the outputs a platform reads (events,
receipts, meter events, the admin API, the activity tap) were still 0.3.0
only, so a hosted network could not move its senders to 0.4.0. Server 0.5.1
closes that. Every output keeps its 0.3.0 name and shape; only where each fact
is read from changes.

- **Lifecycle events** (task-manager/a2a-outputs.ts). The task manager signs
  `mesh.event.task.<state>` for an A2A Task on its creation and on every
  status update, as it does for every 0.3.0 update. `<state>` is the 0.3.0
  spelling (SPEC.md §6.8, §7.1): the A2A state in lower case, and `exhausted`
  for a canceled Task with the budget extension's `exhausted` outcome. The
  data is the 0.3.0 event's: `task_id`, `state`, `requester`, `responder`,
  `offering`, `origin` (without its contest lists), `completed_late` with
  `code: DEADLINE_EXCEEDED`, `cancel_reason` and `canceled_by` on canceled,
  and on failed `failure_reason`, `unmet_need`, `dependency`, `attribution`
  and `unmet_need_declared`. An artifact update announces nothing.
- **Receipts and meter events.** `mesh.event.metering.task_completed` (not
  for a trial), `task_canceled` (not for a trial or an exhausted Task) and
  `task_trial`, with the 0.3.0 fields: `task_id`, `requester`, `responder`,
  `offering`, `context_id` (the Task's `contextId`), the times and
  `duration_ms`, `cost` (the responder's `payload.cost` beside `payload.a2a`),
  `budget` (the starting Message's budget extension in the 0.3.0 shape,
  replaced by a higher revision from the requester), and `completed_late`,
  `cancel_reason`, `canceled_by`, `ended`, `rated_micro` as on 0.3.0. The
  terminal meter events (`tasks_completed`, `task_ms`, with `trial: true` for
  a trial) derive from the terminal frame. A failed or rejected Task gets no
  receipt, as on 0.3.0.
- **Reasons and attribution.** The cancel reason is the cancel extension on
  the canceled Task, else on the CancelTask the task manager saw for it, else
  `user_requested` (§12.6). The failure reason, `unmetNeed` and `dependency`
  come from the failure extension (§12.7). The attribution of SPEC.md §10.8a
  is computed against the responder's declared needs; an `attribution` in
  the extension is ignored. A failed or canceled Task whose reason object is
  outside §10.8 is not applied, as a 0.3.0 update so shaped is refused.
- **Completed late** is the budget extension's `completed_late` outcome, or
  a completion after the deadline of the budget the starting Message set, by
  the task manager's clock (§7.7).
- **Trial work** (§12.8, binding 0.4.0-draft): a Task whose starting Message
  carries the trial extension is recorded `trial: true` and gets the trial
  receipt and trial meter events.
- **Origin and who canceled** (SPEC.md §7.1, §10.8). The origin tap reads
  0.4.0 frames through a view of their A2A object (origin-tap.ts
  `ledgerView`): a SendMessage's offering and the Task id its Message names,
  a CancelTask as a cancel request, and an answer's Task id; the reads, the
  push notification configs and the extended card bind nothing. The ledger
  works on both Task stores as one (task-records.ts), so it attaches an
  origin to an A2A record and settles its `canceled_by` there. On 0.4.0 only
  the server agent publishes Task changes, so `canceled_by.party` is always
  `responder`, and the original requester's CancelTask verifies it
  (`via: "cancel_request"`). A GetTask settles an unverified attribution, as
  a 0.3.0 read does.
- **Stranded delegates.** A canceled A2A Task flags the live A2A Tasks in its
  context that its responder requested, and announces each on
  `mesh.event.task.stranded`.
- **The record** beside each A2A Task now also holds `offering`, `trial`,
  `budget`, `reported_spend`, `origin` and the contest fields, `canceled_by`,
  the reasons, `attribution`, `completed_late`, `stranded` and `frames` (the
  signed frames that changed the Task, at most 50).
- **Admin API.** `GET /admin/v1/a2a-tasks[?updated_after=]` and
  `GET /admin/v1/a2a-tasks/:id` (the privileged read, the ledger projected
  onto it), each row with `wire: "0.4.0"` and the record beside the Task. A
  sibling endpoint, so `/admin/v1/tasks` and its rows are unchanged.
- **Activity tap** (activity-service.ts, shared/a2a-frames.ts
  `activityView`). A 0.4.0 request is recorded under the offering its Message
  names (the offering extension, or the older keys), else the agent's one
  declared offering from the registry (§12.1), else `unknown`. CancelTask is
  `task.cancel`; the reads, push configs and the extended card are
  `a2a.<method>`, a name no agent declares, so they are never priced as the
  agent's offering. The Task id is the one the request names, or the one its
  answer carries. The 0.4.0 accept is a delivery signal, a usage receipt
  beside `payload.a2a` is lifted from the frame that answers the call or
  reports the final state, a reply naming the Message it answers (§12.9) is
  metered as that exchange's answer, and a trial call's meter events and ring
  row say `trial: true`. The audit backstop (witness-fold.ts) reads 0.4.0
  frames through the same view.
- **Gateway relay doors** (a2a-gateway/src/inbound/relay.ts). A relay turn
  to an agent whose manifest lists the binding goes as SendMessage in a
  0.4.0 frame (the input as the Message's parts, the offering extension, the
  context id, the attribution marker and the front end's meta on the
  envelope); the A2A answer comes back as `{kind, status, output, message?}`,
  as before: a Message is `done`/`completed`, a terminal Task `done` with its
  0.3.0 state, a running Task `late`, and a queued request is held for its
  late A2A answer. Other agents keep the 0.3.0 call. The binding
  pass-through now carries `meta.a2a_bridge` too (SDK `A2ACallOptions.meta`).

### Release

Server and gateway 0.5.1 (additive: nothing a deployment acts on), with SDK
0.67.0 and its CHANGELOG entry (the trial, reply and receipt helpers of
binding 0.4.0-draft §12.8 to §12.10, and `A2ACallOptions.meta`). Nothing is
published, tagged or released here.

### Left open

- **The receipt issuer is not in this repository.** EXT-15 receipts are
  issued by whoever operates the mesh (on AgentMesh, the platform); this
  server keeps no issuer. The SDK's `receiptLevelOf` reads the 0.4.0 ask and
  `withReceipt` writes the receipt into a Task's metadata, but the binding
  does not say how a receipt the platform signs reaches the stored Task, which
  only the server agent's frames move (§7.3). Until it does, a `GetTask`
  answered from the store returns the receipt only when the server agent
  itself put it there.
- **Overdue.** The 0.3.0 overdue sweep marks a record and notifies the
  requester with a 0.3.0 update. On 0.4.0 the mark is `{"overdue": true}` on
  the status update the server agent sends (§12.2), and the task manager,
  which never publishes A2A frames, does not sweep A2A Tasks.
- **Budget revisions.** On 0.3.0 the task manager checks and rebroadcasts a
  revision and emits `task.budget_rejected`; on 0.4.0 a revision is a
  Message the server agent judges, and the task manager only records a
  higher revision for the receipt.
- **Invalid transitions.** `task.invalid_transition` is a 0.3.0 event; on
  0.4.0 a refused change leaves the Task as it was, and a party learns of it
  from the Task (§7.3).
- **0.3.0 trial calls in the activity tap** are not marked `trial: true` on
  their request and response meter events (only their task receipt says
  trial). The 0.4.0 path marks them; doing the same on 0.3.0 changes how its
  bare trial calls rate, so it is left for a decision.

## Where this implementation still stops short

- Credentials issued before `MESH_WIRE_0_3_0=refuse` keep their Task
  subscribe grants until they are renewed.
- A sealed `GetTask` cannot be relayed to the task store (the store must read
  the frame), so the node answers it from its own copy.

## Versions

SDK 0.65.1 to 0.66.0, server and gateway 0.4.10 to 0.5.0, with the SDK's
CHANGELOG entry; then SDK 0.67.0 and server and gateway 0.5.1, as the
section above says. Nothing is published, tagged or released here.
