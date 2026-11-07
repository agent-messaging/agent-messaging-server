# Plan: the A2A binding (wire version 0.4.0)

The authority is the binding, `messaging/bindings/a2a.md` in the standards
repository (A2A over Agent Messaging, 0.1.0-draft). Section numbers below are
the binding's. This plan says what changes where in this repository, and how
the old wire (0.3.0) and the new one (0.4.0) live side by side.

## What changes

Agent Messaging stops having its own task model on the wire. A call between
agents is an A2A operation carried in a `request` frame, and each answer is a
`respond` frame, with the A2A objects (Message, Task, Part, Artifact, the
stream events) in A2A 1.0's JSON form. Frames say `"v": "0.4.0"` and never
carry the envelope fields `task_id`, `context_id` or `artifacts` (§4).

## The SDK (`sdk-typescript/`)

A new folder, `src/a2a/`:

- `types.ts`: the A2A 1.0 objects, written by hand from `a2a.proto`'s JSON
  form (camelCase fields, enum names as strings). Every request and response
  object of the eleven operations.
- `binding.ts`: the binding URI, wire version `0.4.0`, the operation names,
  building and reading frame payloads (`{a2a: {method, params}}` and
  `{a2a: {result}}`), the check that refuses `task_id`, `context_id` and
  `artifacts` on a 0.4.0 frame (`INVALID_ENVELOPE`), service parameters in
  `meta.a2a` (case-insensitive names, string values, 8 KiB cap, §7), the
  terminal and interrupted states, and stream framing (`seq`, `final`, §8).
- `errors.ts`: `A2AError`, the A2A error names with their JSON-RPC codes, and
  the respond-frame error shape of §9 (`code` is the A2A name,
  `details.a2a.code` the integer, `details.a2a.data` the data). Channel errors
  keep their Agent Messaging codes.
- `extensions.ts`: the five extension URIs of §12 and helpers to read and
  write each one's data in `metadata`: offering, budget (with the `exhausted`
  outcome on `TASK_STATE_CANCELED` and the `insufficient` outcome on
  `TASK_STATE_REJECTED`), audience, economics (`paymentRequired`) and
  artifact references.
- `client.ts`: `mesh.a2a.*`, one call per operation: `sendMessage`,
  `sendStreamingMessage` (an async iterator of stream events), `getTask`,
  `listTasks`, `cancelTask`, `subscribeToTask`, the four push notification
  config calls and `getExtendedAgentCard`. Each sends a 0.4.0 request frame to
  the agent's inbox and reads the respond frames that come back.
- `server.ts`: the server agent's side. `mesh.a2a.serve(handler)` installs a
  handler that receives an A2A Message and returns a Message or a Task, and
  can emit status and artifact updates through a context while it runs. The
  SDK keeps one event sequence per Task, sends the first event to the client's
  inbox and every later event to `mesh.task.{taskId}.stream`, with `seq` from
  0 and `final: true` on the event that ends the stream. `GetTask`,
  `ListTasks` and `SubscribeToTask` are answered from the mesh's durable task
  store (below) by relaying the client's signed frame to the task manager,
  which applies the access rule of §10. `CancelTask` reaches the handler's
  cancel hook, and a Task already in a terminal state answers
  `TaskNotCancelableError`. The push notification operations answer
  `PushNotificationNotSupportedError`, and the agent's card says
  `pushNotifications: false`. `GetExtendedAgentCard` answers the card the
  agent configured, or `ExtendedAgentCardNotConfiguredError`.

`mesh.ts` gets one branch in its inbox dispatch: a 0.4.0 request goes to the
A2A side after the checks every request already gets (signature, `to`,
freshness, hops, revoked or paused senders, audience). An agent that serves
A2A advertises the binding URI in its manifest's `capabilities`, which is how
the gateway knows to send it 0.4.0 frames.

### 0.3.0 and 0.4.0 together (§14)

- Every 0.3.0 call stays as it is: `request`, `requestStream`, `onRequest`,
  `onStreamRequest`, `awaitTask`, `cancel` and the task update subjects. Their
  docs say they are deprecated in favor of `mesh.a2a`; nothing is removed.
- The SDK answers each request in the wire version it arrived in. A 0.4.0
  `SendMessage` to an agent that has only 0.3.0 handlers is passed to the
  handler for the offering it names (the offering extension, or the agent's
  only offering), and the handler's answer comes back as an A2A Message. A
  0.3.0 request to an agent that has only an A2A handler is passed to it as an
  A2A Message, and a Message or a finished Task comes back as a 0.3.0 answer.
- The envelope builder takes the wire version as a parameter; it stays
  `0.3.0` unless a 0.4.0 frame is being built. Decoding already accepts both.

## The server (`server/`)

- A new keyed store, `mesh_a2a_tasks`, holds one record per A2A Task id:
  `{ task, requester, responder, engagement, seq, created_at, updated_at }`.
  The Task is A2A's object, unchanged; the parties and the engagement sit
  beside it (§11), never inside it.
- The task manager folds the frames that create and move Tasks into it: the
  first answer, observed on the client's inbox (the tap it already runs), and
  every later event on `mesh.task.*.stream`. Only the recorded responder moves
  a Task, events apply in `seq` order, and a Task in a terminal state does not
  move again. The requester is the verified `from` of the request the answer
  replied to when this instance saw it, otherwise the answer's `to`. The
  engagement is the request's `meta.engagement` when it carried one.
- Two service subjects answer the server agent's node:
  `mesh.task.a2a.get` (GetTask, and the snapshot SubscribeToTask starts from)
  and `mesh.task.a2a.list` (ListTasks). Each carries the client's own signed
  frame. The task manager checks that the node is the Task's responder, that
  the client's frame verifies and was addressed to that responder, and that
  the client created the Task. Anyone else gets `TaskNotFoundError`, so a
  Task's existence is not disclosed (§10).
- A 0.4.0 frame carrying `task_id`, `context_id` or `artifacts` is refused with
  `INVALID_ENVELOPE` wherever the server reads one.
- Every 0.3.0 path (task updates, `mesh.task.get.*`, origins, budgets,
  cancels, the overdue sweep) is unchanged. The new subjects are added to the
  credential templates that already grant `mesh.task.get.*`.

## The A2A gateway (`a2a-gateway/`)

- Inbound (an HTTP A2A client calling a mesh agent): when the agent's
  manifest lists the binding, the gateway passes the A2A request object from
  JSON-RPC or HTTP+JSON into a 0.4.0 frame and the A2A result back, without
  translating. Agents that do not list it keep the 0.3.0 translation.
  `ListTasks` and `SubscribeToTask` are carried for binding agents.
- Generated cards list the binding in `supportedInterfaces`
  (`url` = mesh home + `/agents/` + handle or agent ID, §3) beside the
  JSON-RPC and HTTP+JSON interfaces. State spellings are A2A 1.0's.
- Identity mapping and EXT-14 (Agent Messaging over A2A) are unchanged.
- `MAPPING.md` says all of this.

## Tests

Unit tests in each package for every operation, the error mapping, streaming
with `seq` and a resume after a gap, a Task that runs longer than the reply
window, the exhausted outcome, the offering extension, the refusal of the old
envelope fields on 0.4.0, and 0.3.0 next to 0.4.0. If the standards repo's
`messaging/conformance/a2a-binding.json` is there, the conformance runner
reads it. If `@a2a-js/sdk` installs, a test has an A2A JS client call a mesh
agent served by `mesh.a2a.serve` through the gateway.

## Versions

SDK 0.65.1 to 0.66.0, server and gateway 0.4.10 to 0.5.0, with CHANGELOG
entries. Nothing is published, tagged or released here.
