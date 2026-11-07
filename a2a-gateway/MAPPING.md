# The A2A Bridge: A2A's HTTP bindings in front of an Agent Messaging mesh

**Version:** 0.9.1-draft
**Status:** Working Draft
**Date:** 2026-07-14
**Revised:** 2026-11-07. 0.9.1-draft follows the binding's 0.3.0-draft: streams are read by `streamId` and end as A2A says, every operation on a Task is answered only to its readers, and the failure extension, the overdue and completed-late marks and the cancel-reason errors pass through. In 0.9.0-draft both sides of the bridge carry the same A2A objects, under the binding "A2A over Agent Messaging" (`a2a.md`, §13). Version 0.8.0-draft and earlier mapped between A2A's task model and an Agent Messaging task model of its own, which no longer exists.
**Applies to:** Agent2Agent (A2A) Protocol 1.0, JSON-RPC and HTTP+JSON bindings · A2A over Agent Messaging (`a2a.md`), wire version 0.4.0 · Agent Messaging 0.10 (SPEC.md) · PACT 1.0 (§14)

> This document specifies how a bridge serves agents on an Agent Messaging
> mesh to clients that use A2A's HTTP bindings, and how it attaches HTTP A2A
> agents to a mesh. Any bridge implementation, in any language and against any
> Agent Messaging transport binding, that follows it is interoperable. The
> Agent Messaging Server's A2A gateway is the reference implementation.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted
as described in RFC 2119.

---

## 1. Purpose

A2A defines what agents say to each other. Its standard bindings carry that
over HTTP and assume each agent has a public URL. Agent Messaging is the
channel for agents that have no URL: reach through firewalls, signed identity,
admission, presence and events over one outbound connection. The binding "A2A
over Agent Messaging" (`a2a.md`) carries A2A's operations and data model,
unchanged, over a mesh.

The bridge is where A2A's HTTP bindings and the mesh meet. It makes both
statements true at once:

- **Inbound:** a stock A2A client, over JSON-RPC or HTTP+JSON, can call any
  bridge-exposed mesh agent, with no Agent Messaging code.
- **Outbound:** any A2A server on the public web can appear on a mesh as a
  discoverable, addressable agent, with no change to that server.

Both sides carry the same A2A objects: the operations, Tasks, Messages, Parts,
Artifacts and errors of A2A 1.0, in A2A's JSON form. So the bridge moves A2A
objects between an HTTP request and a signed frame (binding §4), and maps
identity at the edge (§2, §9). It translates no A2A object.
What it adds is the channel's part: which mesh identity signs, how a caller
with no key is admitted, and how the channel's own answers (the accept signal
and the queued acknowledgement) reach an HTTP caller.

## 2. The Bridge Is a Node

The bridge is not a new protocol concept. It is an Agent Messaging **node**
(SPEC.md §4): it holds one credentialed connection to a mesh and vouches for
hosted agents that do not hold their own credentials. Both bridge directions
are instances of that one concept:

| Direction | Who the node hosts | What the vouch means |
|---|---|---|
| Inbound | A mesh identity minted for each external A2A caller | "This traffic entered through me; I attest to its origin channel, not its author" |
| Outbound | A mesh identity minted for each attached external A2A server | "This agent is reachable through me over HTTPS; I attest to the endpoint, not its operator" |

A bridge MUST connect as a node and register hosted identities under its node
vouch (SPEC.md §4.4). A bridge MUST NOT share one mesh identity across
distinct external parties in a way that makes their traffic indistinguishable.

### 2.1. Trust Boundary Rules (Normative)

Since Agent Messaging 0.8 the rules every bridge follows are SPEC.md §4.15,
"Identity bridges", and this bridge is one bridge under them: rules 1, 2 and 5
below are its rules 1, 2 and 4 applied to A2A, and §9.0 below is its rule 3.
Where this section and §4.15 differ, §4.15 governs. What follows is kept for
the A2A particulars.

For a caller with no Agent Messaging key, end-to-end Ed25519 signatures do
not traverse the HTTP leg, in either direction. Inside the mesh, a signature
on bridged traffic is the **bridge's vouch**, not the far party's signature.
A caller that does hold a key carries its own signed frame across the leg
instead (EXT-14, Agent Messaging over A2A): the bridge relays it unchanged and
signs nothing, and the rules below do not apply to it. For bridged traffic:

1. A bridge MUST sign bridged frames with the hosted identity it minted,
   under its own node vouch. It MUST NOT present bridged traffic as
   natively signed by the external party.
2. Bridged agents MUST carry the bridge extension marker in their manifest
   and card (§8 below) so discovery consumers can distinguish bridged from
   native agents.
3. Operators SHOULD attest a bridge node's `trust_tier` at no higher than
   `standard`. A bridge node MUST NOT be attested `verified` unless the
   operator also controls or audits the external endpoints it attaches.
4. A bridge MUST NOT expose mesh agents inbound unless they are visible to
   the bridge's own discovery scope. Agents with `visibility: "private"` or
   `"unlisted"`, and sandbox-clamped agents, MUST NOT be exposed unless the
   agent's owner explicitly configures the exposure.
5. On the outbound HTTP leg, TLS authenticates the remote server. A bridge
   SHOULD verify A2A agent card JWS `signatures` at attach time when present,
   and MUST record whether verification succeeded in the manifest marker.

## 3. Version Pinning

- On the HTTP side the bridge serves **A2A 1.0** over two bindings: the
  **JSON-RPC binding** (A2A §9: JSON-RPC 2.0 over HTTPS, Server-Sent Events
  for streaming) and the **HTTP+JSON binding** (A2A §11), specified in §13
  below.
- On the mesh side it speaks the binding "A2A over Agent Messaging"
  (`https://agentmessaging.ai/bindings/a2a/v1`), wire version `0.4.0`. While
  the transition window of binding §14 is open it also serves and attaches
  agents that answer only 0.3.0 envelopes, as §5.2 and §7.3 say.
- Generated agent cards MUST declare the interfaces as §8.1 says. A client
  picks by binding and version, not by position.
- Requests carrying an `A2A-Version` the bridge does not support MUST
  receive `VersionNotSupportedError` (`-32009` on JSON-RPC, reason
  `VERSION_NOT_SUPPORTED` on HTTP+JSON). PACT routes are the one exception
  (§14.7).
- The A2A gRPC binding is out of scope for this version.

## 4. Operations

### 4.1. Every Operation Passes Through (Inbound)

The bridge carries every A2A operation the binding carries (binding §5):

| A2A operation | JSON-RPC method | HTTP+JSON route (§13.1) |
|---|---|---|
| `SendMessage` | `SendMessage` | `POST message:send` |
| `SendStreamingMessage` | `SendStreamingMessage` | `POST message:stream` |
| `GetTask` | `GetTask` | `GET tasks/{id}` |
| `ListTasks` | `ListTasks` | `GET tasks` |
| `CancelTask` | `CancelTask` | `POST tasks/{id}:cancel` |
| `SubscribeToTask` | `SubscribeToTask` | `POST tasks/{id}:subscribe` |
| `CreateTaskPushNotificationConfig` | `CreateTaskPushNotificationConfig` | `POST tasks/{id}/pushNotificationConfigs` |
| `GetTaskPushNotificationConfig` | `GetTaskPushNotificationConfig` | `GET tasks/{id}/pushNotificationConfigs/{configId}` |
| `ListTaskPushNotificationConfigs` | `ListTaskPushNotificationConfigs` | `GET tasks/{id}/pushNotificationConfigs` |
| `DeleteTaskPushNotificationConfig` | `DeleteTaskPushNotificationConfig` | `DELETE tasks/{id}/pushNotificationConfigs/{configId}` |
| `GetExtendedAgentCard` | `GetExtendedAgentCard` | `GET extendedAgentCard` |

For each call the bridge:

1. admits the caller (§9) and resolves the agent the interface URL names
   (§2.1 rule 4);
2. takes the A2A request object from the call: the JSON-RPC `params`, or, on
   HTTP+JSON, the body with the path and query parameters placed in the
   fields A2A §11 names for them;
3. sends a request frame (binding §4) to the agent, with that object
   unchanged as `payload.a2a.params` and the operation's name as
   `payload.a2a.method`, signed by the caller's hosted identity and carrying
   the §8.3 markers in `meta`;
4. copies the call's A2A service parameters (`A2A-Version`,
   `A2A-Extensions`) into the frame's `meta.a2a` (binding §7);
5. returns the answer frame's `payload.a2a.result` unchanged, as the JSON-RPC
   `result` or the HTTP+JSON body, or returns its `error` as §7 says.

The bridge MUST NOT change the A2A object in either direction, apart from the
offering keys of §4.5 during the transition window. It MUST NOT answer an
operation itself with `UnsupportedOperationError`. What the agent does not
support, the agent answers as A2A says, and the bridge passes that answer on:
for example `PushNotificationNotSupportedError` from an agent whose card says
`pushNotifications: false`, or `ExtendedAgentCardNotConfiguredError` from an
agent with no extended card.

Particulars:

- **Reading Tasks.** `GetTask`, `ListTasks` and `SubscribeToTask` are answered
  by the agent's node from its task store. They, `CancelTask` and the push
  configuration operations are answered only for Tasks the requesting identity
  may read (binding §10); for any other Task the agent answers
  `TaskNotFoundError`. Because a credentialed caller keeps one
  hosted identity for its whole life (§9.0), it reads the Tasks it created
  with that credential and no others. An anonymous caller's identity lasts one
  session, and so does what it can read.
- **Push notification configurations.** The agent's node calls the webhook
  over plain HTTPS (binding §5). A bridge operator MAY refuse the four
  configuration operations by policy, with `PushNotificationNotSupportedError`
  (`-32003`), and a bridge that does MUST declare
  `capabilities.pushNotifications: false` in the cards it generates, whatever
  the agent's own card says.
- **The extended card.** `GetExtendedAgentCard` reaches the agent, which knows
  the caller by its hosted identity. A bridge that refuses it by policy
  answers `ExtendedAgentCardNotConfiguredError` (`-32007`) and declares
  `capabilities.extendedAgentCard: false`.

### 4.2. Results

A2A decides the shape of every result, and the bridge returns what the agent
returned. `SendMessage` answers with a Message, when the work finished in one
round, or with a Task, when the work continues (binding §5). A Task's id is
the agent's own. A client continues with it as A2A says, by sending a Message
with that `taskId`, by `GetTask` or by `SubscribeToTask`.

A Message sent to a Task in a terminal state is the agent's to refuse, with
`UnsupportedOperationError` as A2A §3.1.1 says. A Message sent with a `taskId`
the caller cannot read is answered with `TaskNotFoundError` (binding §10). The
bridge forwards both such Messages and both answers unchanged.

### 4.3. The Channel's Answers

Two answers come from the channel, not from A2A, and an A2A client cannot
read them as they are. The bridge reads them for the caller.

- **The accept signal** (SPEC.md §6.4a; binding §4, §11), a channel frame
  whose payload is `{"accepted": {}}`, says the request reached a live
  handler. The bridge ignores members of `accepted` it does not know. It resets the bridge's wait for the A2A answer and is never
  returned to the caller.
- **The queued acknowledgement** (SPEC.md §6.4a) says the request is waiting
  in an inbox and no A2A answer has come yet. The bridge answers the caller
  with a Task that it holds itself, whose `id` is the request frame's `id`. An
  acknowledgement that says `delivered: true` or `paused: true` gives that
  Task the state `TASK_STATE_SUBMITTED`. One that says neither means the agent
  has not let the caller in, and the Task is in `TASK_STATE_AUTH_REQUIRED` as
  EXT-14 §9 says.

The Task the bridge holds is its own record of the exchange, and its
`metadata` carries the bridge marker's URI (§8.3) with
`{"held": true}`, so a caller can tell it from a Task the agent made. When
the agent's first A2A answer to the request arrives:

- a Message moves the held Task to `TASK_STATE_COMPLETED` with that Message
  as its status message;
- a Task replaces it: from then on the bridge answers `GetTask`,
  `SubscribeToTask` and `CancelTask` on the held id with the agent's Task, and
  the held id's `metadata` names the agent's Task id under the marker's URI as
  `{"held": true, "taskId": "<the agent's Task id>"}`. A client SHOULD continue
  with the agent's Task id.

Only an answer from the agent the request went to, naming the request in
`in_reply_to`, settles a held Task.

### 4.4. Streaming

`SendStreamingMessage` and `SubscribeToTask` answer with A2A stream events
(binding §8). The bridge reads the first event from the caller's inbox and the
later ones from a durable subscription to `mesh.task.{taskId}.stream` that it
holds for the caller's hosted identity, starting from the first event of the
stream (binding §8). Several streams of one Task share that subject, so the
bridge reads only the frames whose `payload.a2a.streamId` is the `id` of the
request frame it sent, and skips the rest. It writes each frame's
`payload.a2a.result`, which is one A2A `StreamResponse`, as one Server-Sent
Event: on JSON-RPC as the `result` of a JSON-RPC response with the request's
`id`, and on HTTP+JSON bare.

- **Order.** The bridge writes its stream's events in `payload.a2a.seq` order
  and never writes an event past a gap. It drops a frame whose `seq` it has already
  written.
- **A dropped mesh connection.** The bridge resumes its durable subscription
  after the last event it acknowledged, and the HTTP stream continues without
  a gap. If it cannot resume the subscription, it calls `SubscribeToTask` for
  the caller and writes the Task's current state as the next event.
- **The end.** The stream ends when A2A says it ends: at a terminal state, or
  with the Message that answers a `SendStreamingMessage` without a Task. The
  bridge closes the HTTP stream after it writes the event whose frame says
  `payload.a2a.final: true`. In an interrupted state
  (`TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`) the stream stays
  open, as A2A §3.1.2, §3.1.6 and §7.6.1 say, and so does the bridge's HTTP
  stream. A frame that says `final: true` on any other event is a broken
  stream (below).
- **A broken stream.** A frame that fails verification, that does not come
  from the agent, or that leaves a gap the bridge cannot close MUST surface
  as `InvalidAgentResponseError` (`-32006`), and the bridge closes the stream.
  It MUST NOT be reported as a clean end.
- **A dropped HTTP connection.** The client reconnects with `SubscribeToTask`,
  which passes through like any operation.

Each event is a signed frame of its own (binding §8), so the bridge checks
each one as it checks any answer.

### 4.5. Offering Routing

An agent that declares several offerings learns which one a Message calls from
the offering extension, `https://agentmessaging.ai/extensions/offering/v1`
(binding §12.1): `{"offering": "<offering id>"}` in the Message's `metadata`
under that URI. ("Skill" is A2A's word for the card entries; each maps to an
offering, SPEC.md §8.5.) The bridge passes the Message unchanged, and the
agent routes it: it serves its only offering when the Message names none, and
otherwise answers `InvalidParamsError` (`-32602`) listing its offerings in the
error's data.

**The older keys.** Before 0.9.0-draft the bridge read the offering from
`message.metadata["agentmesh.offering"]`, or its pre-rename spelling
`agentmesh.skill`. While the transition window of binding §14 is open, a
bridge MUST still accept them from a caller with no key:

1. A Message that carries the extension's key is passed unchanged, whatever
   else it carries, unless an older key names a different offering, which is
   refused with `InvalidParamsError` (`-32602`).
2. A Message that carries only an older key gets the extension's key added,
   with the same offering, before the bridge signs the frame, and the
   extension's URI is added to the frame's `A2A-Extensions` service
   parameter. The older key stays where it is.

A bridge MAY check the offering against the agent's declared offerings itself
and refuse an undeclared one with the same error and the same data, so that
the refusal reads the same whichever of them makes it. A carried frame
(EXT-14) is never changed, and its offering is checked as EXT-14 §4 says.

## 5. Task States

### 5.1. A2A's States, Unchanged

Task states are A2A's own (A2A §4.1.3), and both sides of the bridge carry
them in A2A's JSON form, by enum name:

| A2A state | Kind |
|---|---|
| `TASK_STATE_SUBMITTED` | Active |
| `TASK_STATE_WORKING` | Active |
| `TASK_STATE_INPUT_REQUIRED` | Interrupted |
| `TASK_STATE_AUTH_REQUIRED` | Interrupted |
| `TASK_STATE_COMPLETED` | Terminal |
| `TASK_STATE_FAILED` | Terminal |
| `TASK_STATE_CANCELED` | Terminal |
| `TASK_STATE_REJECTED` | Terminal |

There is nothing to map. A bridge MUST NOT invent, merge, rename or drop a
state. The JSON-RPC and HTTP+JSON bindings of A2A 1.0 spell states the same
way. The lowercase spellings such as `"input-required"` and `"canceled"` were
A2A 0.3's, and a bridge MUST NOT send them on either binding.

**Budget outcomes.** Each outcome of a budget puts the Task in an A2A state,
and the Task's `metadata` names the outcome under the budget extension's URI,
`https://agentmessaging.ai/extensions/budget/v1` (binding §12.2):

| Outcome | A2A state |
|---|---|
| `insufficient`, refused at admission, with the `estimate` | `TASK_STATE_REJECTED` |
| `deadline_unmeetable`, refused at admission, with `earliestCompletion` | `TASK_STATE_REJECTED` |
| `ceiling_reached`, paused for more money, with `spent` and `estimateToFinish` | `TASK_STATE_INPUT_REQUIRED` |
| `exhausted`, ended by an engagement's not-to-exceed cap (Agent SoW §5.5.5) | `TASK_STATE_CANCELED` |

Two marks travel the same way, and neither is a failure: `{"overdue": true}`
on the status update event that reports a deadline passed while the work goes
on, with the state unchanged, and `{"outcome": "completed_late"}` on a Task
in `TASK_STATE_COMPLETED` that finished after its deadline.

The bridge passes all six unchanged. A client that knows the extension MUST
NOT record an exhausted Task as failed and MUST NOT retry it. Whether to send
any other canceled or refused work again is the client's choice.

**Cancel reasons.** A `CancelTask` request may carry its reason under the
cancel extension's URI, `https://agentmessaging.ai/extensions/cancel/v1`
(binding §12.6), and the canceled Task carries the same object. The bridge
passes both unchanged. A stock A2A client that sends no reason is a client
that does not declare the extension, and the agent records its cancel as
`user_requested`. A client that declares the extension and sends no reason, or
a reason outside the list, gets `InvalidParamsError` from the agent, with the
reasons in the error's data, and the bridge passes that on. The bridge MUST
NOT add a reason on the caller's behalf.

**Failure reasons.** A Task in `TASK_STATE_FAILED` may carry
`{"reason": ..., "unmetNeed": ..., "dependency": ...}` under the failure
extension's URI, `https://agentmessaging.ai/extensions/failure/v1` (binding
§12.7). The bridge passes it unchanged and never adds one.

### 5.2. Agents That Answer in 0.3.0 Envelopes

While the transition window of binding §14 is open, a bridge also serves mesh
agents that answer only 0.3.0 envelopes, and attaches nothing new in that
form. For such an agent the bridge sends the 0.3.0 `request` payload of Agent
Messaging 0.9 and presents what comes back as A2A objects, with the states
spelled as A2A 1.0 spells them:

| 0.3.0 state | A2A state |
|---|---|
| `submitted` | `TASK_STATE_SUBMITTED` |
| `working` | `TASK_STATE_WORKING` |
| `input_required` | `TASK_STATE_INPUT_REQUIRED` |
| `auth_required` | `TASK_STATE_AUTH_REQUIRED` |
| `completed` | `TASK_STATE_COMPLETED` |
| `failed` | `TASK_STATE_FAILED` |
| `canceled` | `TASK_STATE_CANCELED` |
| `rejected` | `TASK_STATE_REJECTED` |
| `exhausted` | `TASK_STATE_CANCELED`, with `{"outcome": "exhausted"}` under the budget extension's URI and `"agentmesh.state": "exhausted"` in the Task's `metadata` |
| `input_required` with the error `BUDGET_EXHAUSTED` (the 0.3.0 budget pause) | `TASK_STATE_INPUT_REQUIRED`, with `{"outcome": "ceiling_reached", "spent": ..., "estimateToFinish": ...}` under the budget extension's URI, from the error's `details.spent` and `details.estimate_to_finish` |

A failed update from such an agent that carries a `reason` (with its
`unmet_need` or `dependency`) gives the failed Task the failure extension's
object, `{"reason": ..., "unmetNeed": ..., "dependency": ...}`. A completion
marked `DEADLINE_EXCEEDED` gives the completed Task
`{"outcome": "completed_late"}` under the budget extension's URI.

A `CancelTask` for such an agent becomes its `task.cancel` request (Agent
Messaging 0.9 §10.8), with the reason, note and extra fields of the cancel
extension's object when the request carries one, and `user_requested` when it
does not.

A 0.3.0 request carries an `input` object, not Parts, so for such an agent
the bridge also maps the Parts as 0.8.0-draft did:

| A2A Message Parts | 0.3.0 `input` |
|---|---|
| Exactly one `data` Part | that Part's value, as it is |
| One or more `text` Parts and no `data` Part | `{"text": "<the texts joined by a line feed>"}` |
| `text` and `data` Parts mixed | the first `data` Part's value, with `{"text": ...}` added if it has no `text` member |
| Any `raw` or `url` Part | refused with `ContentTypeNotSupportedError` (`-32005`) |

| 0.3.0 `output` | A2A Parts |
|---|---|
| `{"text": "<string>"}` and no other member | one `text` Part |
| any other JSON value | one `data` Part carrying the value |

The key `agentmesh.state` is what 0.8.0-draft put on such a Task. A client
reading Tasks during the window MUST treat a `TASK_STATE_CANCELED` Task that
carries either mark as one that stopped at its cap. When the window ends, a
bridge stops writing `agentmesh.state`.

## 6. Parts

Parts are A2A's own (A2A §4.1.6) on both sides, so they pass unchanged: a
`text`, `raw`, `url` or `data` Part, with its `mediaType`, `filename` and
`metadata`. Version 0.8.0-draft's mapping of parts to a mesh `input` object,
and its refusal of file parts, are withdrawn.

**Parts by reference.** A Part too large to travel inline on a mesh is a `url`
Part whose value is an Agent Messaging artifact reference (SPEC.md §7.5.1),
with the artifact references extension,
`https://agentmessaging.ai/extensions/artifact-refs/v1`, giving its `size`
and `digest` in the Part's `metadata` (binding §6, §12.5). The extension may
sit on a reference of any carrier, an `https:` URL included, and a reader
checks the digest before it uses the bytes.

- **Inbound, a large Part from a caller with no key.** When a `raw` Part
  would make the frame larger than the mesh's message size limit (SPEC.md
  §18.9), the bridge SHOULD store its bytes in the mesh's artifact store as
  the caller's hosted identity and send a `url` Part by reference in its
  place, with the same `mediaType` and `filename`. A bridge that cannot
  refuses the call with the channel error `PAYLOAD_TOO_LARGE` (§7.2).
- **Outbound to a caller with no key.** An HTTP caller cannot resolve a
  `mesh:artifacts:` reference. The bridge MAY replace the Part's `url` with an
  HTTPS link it serves under the same admission as the card, and MUST keep the
  extension's `size` and `digest`, so the caller checks the bytes it fetches.
- **A signed caller (EXT-14).** Nothing in a carried frame or in the agent's
  signed answer is changed. A signed caller resolves references itself with
  its own key (SPEC.md §7.5.4).

## 7. Errors

### 7.1. A2A Errors Pass Through

An A2A error travels on the mesh as a respond frame's `error`, with the A2A
error's name as `code` and the integer A2A's JSON-RPC binding assigns to it as
`details.a2a.code` (binding §9). The bridge returns it unchanged:

- on JSON-RPC, as the JSON-RPC error whose `code` is `details.a2a.code`,
  whose `message` is the frame error's `message` and whose `data` is
  `details.a2a.data`;
- on HTTP+JSON, as §13.3 says, with the reason and status of the table below.

Outbound, the inverse applies: an A2A error from a remote server becomes the
respond frame's `error`, with the A2A name, the integer and the data kept.

| A2A error | JSON-RPC code | HTTP+JSON `reason` | HTTP |
|---|---|---|---|
| `TaskNotFoundError` | `-32001` | `TASK_NOT_FOUND` | 404 |
| `TaskNotCancelableError` | `-32002` | `TASK_NOT_CANCELABLE` | 400 |
| `PushNotificationNotSupportedError` | `-32003` | `PUSH_NOTIFICATION_NOT_SUPPORTED` | 400 |
| `UnsupportedOperationError` | `-32004` | `UNSUPPORTED_OPERATION` | 400 |
| `ContentTypeNotSupportedError` | `-32005` | `CONTENT_TYPE_NOT_SUPPORTED` | 400 |
| `InvalidAgentResponseError` | `-32006` | `INVALID_AGENT_RESPONSE` | 500 |
| `ExtendedAgentCardNotConfiguredError` | `-32007` | `EXTENDED_AGENT_CARD_NOT_CONFIGURED` | 400 |
| `ExtensionSupportRequiredError` | `-32008` | `EXTENSION_SUPPORT_REQUIRED` | 400 |
| `VersionNotSupportedError` | `-32009` | `VERSION_NOT_SUPPORTED` | 400 |
| `InvalidParamsError` | `-32602` | `INVALID_PARAMS` | 400 |
| `InternalError` | `-32603` | `INTERNAL` | 500 |
| `MethodNotFoundError` | `-32601` | (none: an unknown route is §13.1's `404`) | |

The JSON-RPC standard errors keep the names A2A's JSON-RPC binding gives them
(binding §9). `JSONParseError` (`-32700`) and `InvalidRequestError`
(`-32600`) describe a malformed JSON-RPC request, which the bridge's JSON-RPC
interface answers itself before anything reaches the mesh.

A bridge MUST NOT give an agent's A2A error a different name, code or status.

### 7.2. Channel Errors

Errors that come from the channel rather than from A2A, such as a refused
signature, a sender not admitted or a transport timeout, keep their Agent
Messaging codes (SPEC.md §12.2; binding §9) and have no A2A name. The bridge
returns them as JSON-RPC `-32603` with the HTTP status below, keeps the Agent
Messaging code in the JSON-RPC error's `data.agentmesh_code` and the frame
error's `details` in `data.details`. On HTTP+JSON they are §13.3's `INTERNAL`
reason with the same status, and the code in `details[0].metadata.agentmesh_code`.

| Agent Messaging code | HTTP |
|---|---|
| `UNAUTHORIZED`, `TRANSPORT_PERMISSION_DENIED` | 401 or 403 |
| `AGENT_UNAVAILABLE`, `AGENT_OVERLOADED`, `TRANSPORT_NO_RESPONDERS` | 502 |
| `TRANSPORT_TIMEOUT` | 504 |
| `RATE_LIMITED` | 429 |
| `PAYLOAD_TOO_LARGE` | 413 |
| any other | 500 |

One case is an A2A error the bridge raises itself: an answer frame that is
malformed, fails its signature (`INVALID_ENVELOPE`, `IDENTITY_MISMATCH`) or
breaks a stream (§4.4) is `InvalidAgentResponseError` (`-32006`), with the
Agent Messaging code in `data.agentmesh_code`.

### 7.3. Agents That Answer in 0.3.0 Envelopes

During the transition window an error from an agent that answers in 0.3.0
envelopes carries only an Agent Messaging code. The bridge gives the codes
that have an A2A meaning that meaning, and the rest are channel errors (§7.2):

| 0.3.0 code | A2A error |
|---|---|
| `TASK_NOT_FOUND`, `TASK_EXPIRED` | `TaskNotFoundError` |
| `TASK_NOT_CANCELABLE` | `TaskNotCancelableError` |
| `TASK_INVALID_TRANSITION` | `UnsupportedOperationError` |
| `CONTENT_TYPE_NOT_SUPPORTED` | `ContentTypeNotSupportedError` |
| `OFFERING_NOT_FOUND` (legacy `SKILL_NOT_FOUND`), `INPUT_INVALID`, `INVALID_QUERY` | `InvalidParamsError` |
In every case the original code stays in `data.agentmesh_code`.

The two budget refusals at admission are not errors under the binding but
outcomes (§5.1), so for them the bridge answers with a Task it holds (§4.3)
in `TASK_STATE_REJECTED`, carrying the outcome under the budget extension's
URI: `BUDGET_INSUFFICIENT` with `details.estimate` becomes
`{"outcome": "insufficient", "estimate": {"amountMicro": ..., "currency": ...}}`,
and `DEADLINE_UNMEETABLE` with `details.earliest_completion` becomes
`{"outcome": "deadline_unmeetable", "earliestCompletion": ...}`. The 0.3.0
budget pause is §5.2's.

## 8. Agent Cards

### 8.1. Inbound: The Card the Bridge Serves

Served per exposed agent at
`https://<bridge-host>/agents/<agent-id>/.well-known/agent-card.json`.

A mesh agent has an A2A Agent Card of its own (binding §3). The bridge serves
that card with these changes, and no others:

- `supportedInterfaces` lists, in this order, the agent's binding interface
  as the agent's card gives it, then the bridge's two interfaces:

  ```json
  [
    { "url": "https://api.mesh.example.com/agents/<handle or agent-id>",
      "protocolBinding": "https://agentmessaging.ai/bindings/a2a/v1", "protocolVersion": "1.0" },
    { "url": "https://<bridge-host>/agents/<agent-id>/rpc",
      "protocolBinding": "JSONRPC", "protocolVersion": "1.0" },
    { "url": "https://<bridge-host>/agents/<agent-id>",
      "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0" }
  ]
  ```

  A client on a mesh uses the first entry. A client with only HTTP uses one of
  the other two.
- `securitySchemes` and `security` declare exactly what the bridge accepts
  (§9). On the binding interface the signature takes their place (binding §10).
- `capabilities.extensions[]` gains the bridge marker (§8.3), and EXT-14's
  entry where the bridge implements it.
- `capabilities.pushNotifications` and `capabilities.extendedAgentCard` are
  `false` where the bridge refuses those operations by policy (§4.1).

Everything else, including `skills`, `capabilities.streaming` and the
agent's own `capabilities.extensions[]` entries, is the agent's card
unchanged. Where the agent published an Agent Descriptor (SPEC.md §8.13), the
card's description, version and skills come from the Descriptor, and EXT-14's
entry links to the Descriptor with its digest (EXT-14 §10).

**An agent with no card.** During the transition window an agent that
registered only a manifest gets a card made from it:

| Manifest field (SPEC.md §8) | Agent card field (A2A §8.5) |
|---|---|
| `name` | `name` |
| `description` | `description` |
| `version` | `version` |
| `provider.name` / `provider.url` | `provider.organization` / `provider.url` |
| `id` (mesh public key) | the interface URL path and the bridge marker's params |
| `offerings[].id/name/description/tags` | `skills[].id/name/description/tags` |
| `offerings[].examples[]` (`{input, output}` objects) | `skills[].examples[]` (each input serialized to a JSON string) |
| `offerings[].input_modes` / `output_modes` | `skills[].inputModes` / `outputModes` (default `["application/json", "text/plain"]`) |
| any offering with `streaming: true` | `capabilities.streaming: true` |

Such a card lists only the bridge's two interfaces, since the agent does not
speak the binding.

### 8.2. Outbound: An Attached Server on the Mesh

The bridge registers the attached server's card on the mesh as the hosted
identity's card, with one change: `supportedInterfaces` gains, first, the
binding interface for the hosted identity (binding §3), whose URL is the mesh
home, `/agents/` and the hosted identity's agent ID. The remote's own
interfaces stay in the card, after it.

The registration manifest (SPEC.md §8) is made from the card:

| Agent card field | Manifest field |
|---|---|
| `name` | `name` |
| `description` | `description` |
| `version` | `version` |
| `provider.organization` / `provider.url` | `provider.name` / `provider.url` |
| `skills[].id/name/description/tags` | `offerings[].id/name/description/tags` |
| union of `skills[].tags` | `capabilities` |
| `skills[].inputModes` / `outputModes` | `offerings[].input_modes` / `output_modes` |
| `capabilities.streaming` | `offerings[].streaming` on every offering |
| the JSON-RPC or HTTP+JSON `supportedInterfaces` URL | `endpoint` |
| (none) | `id`: mesh public key minted and held by the bridge for this remote |
| (none) | `node`: the bridge node's vouch (SPEC.md §4.4) |
| (none) | bridge marker (§8.3) in `extensions` and `meta` |

Card `examples` (strings) are not converted to manifest examples; they are
dropped rather than guessed at.

### 8.3. The Bridge Marker

This is the A2A form of the general marker of SPEC.md §4.15 rule 4. An inbound
bridged frame carries both: `meta.a2a_bridge` below, which receivers written
before Agent Messaging 0.8 read, and `meta.identity_bridge` with `front: "a2a"`
and the same `caller_kind` and `caller_ref`.

Every bridged manifest MUST include:

```json
{
  "extensions": [{
    "uri": "mesh://extensions/a2a-bridge/v1",
    "description": "This agent is bridged from/to the A2A protocol; mesh signatures are the bridge node's vouch, not the far party's."
  }],
  "meta": {
    "a2a_bridge": {
      "direction": "outbound",
      "endpoint": "https://<remote>/a2a/v1",
      "a2a_protocol_version": "1.0",
      "card_signature_verified": false
    }
  }
}
```

The `direction: "inbound"` marker appears in generated agent cards as the
corresponding `capabilities.extensions[]` entry instead, using the same
canonical URI with a `documentationUrl` pointing at the bridge documentation.
The extension URI is registered in the extensions registry (SPEC.md §17.5).
The same URI keys the bridge's own data on a Task it holds (§4.3).

### 8.4. Messages for the Person

SPEC.md §5.7 lets a sender mark a message for the person behind the receiving
agent. Over A2A the mark is the audience extension of binding §12.3:
`{"audience": "person"}` in the Message's `metadata` under
`https://agentmessaging.ai/extensions/audience/v1`, with the URI listed in the
Message's `extensions`. An agent declares that it keeps §5.7's rules by
listing that URI in its card's `capabilities.extensions[]`; the manifest's
`mesh://extensions/audience/v1` declares the same thing, and a bridge reads
either as the declaration.

**The declaration.** A generated card (§8.1) lists the URI exactly when the
exposed agent declares it. A bridged manifest (§8.2) declares it exactly when
the remote card lists it. A bridge MUST NOT add the declaration in either
direction on its own account.

**Inbound (A2A client to mesh agent).** A marked Message passes unchanged.
The bridge signs the frame with the caller's hosted identity and signs the
digest of the Message's readable text in `meta.readable_text` (Agent Messaging
§5.8). A mark whose value is not a string is refused with
`InvalidParamsError` (`-32602`). A Message carrying the older key
`metadata["agentmesh.audience"]: "person"` and not the extension's key is
read as marked during the transition window, and the bridge adds the
extension's key before it signs, as §4.5 does for offerings. Since the
agent's person answers later, if at all, the agent's answer is usually a
queued acknowledgement, and the bridge holds a Task for it as §4.3 says. The
reply's readable text is the first Part of the Message that completes it,
generated from the signed reply (Agent Messaging §5.8, EXT-14 §6), and the
reply's frame rides in the Message's `metadata` under EXT-14's URI, so
software that shows the text can check it.

**Outbound (mesh agent to remote A2A server).** The bridge is the receiving
node for the bridged agent, so §5.7's receiver rules bind it. When the remote
card lists the URI, the bridge forwards the marked Message unchanged, and the
remote server keeps the rules it declared. When the remote card does not list
it, the bridge MUST refuse the request with `AUDIENCE_NOT_SUPPORTED` (SPEC.md
§12.2) and forward nothing, even when the sender chose to send anyway. A
native receiver that does not know the mark still receives it under the
sender's signature; forwarding over HTTP would make the bridge the party that
drops it, and §5.7 has every carrier keep it.

## 9. Inbound Caller Identity

| Caller presents | Hosted mesh identity |
|---|---|
| No credentials | Ephemeral per-session identity, sandbox-flagged; subject to the guest rate tier |
| A bridge API key (`Authorization: Bearer <key>`) | A stable identity minted at key creation, reused across calls |
| Its own signed frame, under EXT-14 (with whatever credential the bridge requires) | None. The frame travels on the caller's own signature, and the bridge relays it unchanged |

For the first two the identity is bridge-hosted and node-vouched (§2.1 rule 1).
A2A `securitySchemes` in generated cards MUST declare exactly what the bridge
accepts.

Keys may be operator-configured (static) or minted at runtime against an
account (self-serve). A runtime key MUST be stored only as a digest: the raw
key exists once, in the mint response. Revocation MUST take effect on the
next request. The anonymous tier is permitted, never default: a bridge with
no keys configured and anonymity off MUST refuse every caller.

### 9.0 A credentialed caller's identity is durable

This is SPEC.md §4.15 rule 3, "One lasting identity per caller", stated for
A2A callers; the general rule governs where the two differ.

"Stable, reused across calls" in the table above is a promise about the
identity's whole life, not about one process's uptime. A bridge MUST persist
the association between a credentialed caller and the mesh identity it minted
for them, and MUST restore that same identity, with the same mesh public key,
after a restart or after the caller is evicted from any in-memory pool. An
identity re-minted per process is not stable; it merely looks stable to
whoever tries it twice in a row.

Three consequences follow, and they are the reason the rule is stated:

1. **The marker means something.** §2.1 rule 2's marker is only useful if the
   thing it marks keeps its name. The manifest an inbound caller identity
   registers MUST carry the §8.3 marker with `direction: "inbound"`, and it
   SHOULD be `unlisted`: the identity serves no offerings, so open discovery
   must not present it as an agent that answers requests.
2. **A record resolves afterwards.** An audit, activity or settlement row
   names a mesh identity. A bridge MUST be able to resolve a hosted caller
   identity back to the party that presented the credential after the process
   that minted it has exited. Otherwise the row names a string.
3. **A caller keeps its Tasks.** An agent answers Task reads only for the
   identity that created the Task (binding §10). A caller whose identity
   changed would lose every Task it made.

What is persisted MUST NOT include anything a caller could present. The
caller's credential is a digest already (§9 above); the association MUST be
keyed by that digest or another non-reversible handle, never by the raw key.
The identity's own signing seed is secret and MUST be stored with the
protection any private key gets on that platform.

Every frame a bridge sends on a caller's behalf MUST carry the §8.3 inbound
marker in the frame's `meta`, so a receiver reads the attribution from
something the bridge's signature covers rather than from a transport header.
The marker names the direction, the vouching node, the caller's `caller_ref`
(a stable opaque handle) and `caller_kind`. It MUST NOT carry the caller's
account: the frame reaches whichever agent was addressed, and a bridged caller
must not be made more identifiable to strangers than a mesh-native one.
Resolving `caller_ref` to a party is the bridge operator's lookup against the
record, not a fact on the wire.

### 9.1 Gateway refusals are typed

A caller on the far side of a bridge must be able to tell "the agent failed"
from "the gateway refused me". Every refusal originating in the bridge
itself MUST carry a machine-readable `agentmesh_code` in the JSON-RPC error
`data`, drawn from this closed set:

| Code | Meaning | HTTP |
|---|---|---|
| `UNAUTHORIZED` | No or unrecognised credentials | 401 |
| `RATE_LIMITED` | The caller's or the attachment's rate budget is spent | 429 |
| `AGENT_UNAVAILABLE` | The named agent is not served here (unknown, private, or its attachment is suspended) | 200 (JSON-RPC error) |
| `PAYMENT_REQUIRED` | Reserved: the call needs a fee the caller has not arranged | 402 |

A `PAYMENT_REQUIRED` refusal MUST additionally carry, in the same `data`
object: `price_credits` (the quoted price, which is the retail price the
caller pays; the bridge resells the attached agent's work), an
`operator_fee` line disclosing the operator's cut inside that price per
§9.2, a typed `reason` (`no_account` | `insufficient` | `ledger_unreachable`,
with `balance_credits` on `insufficient`), and `accepted`, an array of
settlement-method objects, each `{ method, amount, unit, ... }`. Every entry
quotes in its own denomination. The array is the extension point (SPEC.md
§1.3, payments): today one entry,
`{ method: "agentmesh-credits", amount, unit: "credit", url }`; an
x402-style entry (`{ method: "x402", amount, unit, chain, address }`) is the
intended second, and a consumer that reads the array needs no change when it
appears. Errors raised by the agent pass through as §7 says and carry their
own codes, never these.

### 9.2 The operator's fee is disclosed

**The superseded rule.** Until 2026-08-07 this section stated that
`price_credits` is the retail price the caller pays, that the bridge resells
the attached agent's work, and that the rate the agent's owner set "is
between the owner and the operator, never quoted to callers". That rule is
withdrawn. It is replaced by the rule stated below, and an implementation
that follows the withdrawn rule is no longer conformant with this mapping.
The reversal is deliberate: the old rule was written, published, and
implemented, and the runtime conforms to it today.

**Why it was withdrawn.** Three reasons, in the order they matter.

The caller was quoted one number and was not told it contained two. A
`PAYMENT_REQUIRED` refusal carried a single blended figure, and no refusal,
receipt, listing, or console view separated the owner's rate from the
platform's share. The caller had nothing to check the number against, and no
way to know a third party was inside it.

The concealment was already ineffective. `GET /v1/capabilities` on the
platform API serves `markup_pct` without authentication, and the retail price
is the owner's rate plus a cut derived from exactly that percentage, rounded
up so any nonzero rate earns at least one credit. A caller that reads the
endpoint and the quoted total can invert the arithmetic and recover the
owner's wholesale rate. The old rule did not keep the split private. It kept
the caller from knowing there was a split.

That cut is disclosed as a fixed basis against the owner's rate, not as a
percentage. Agent SoW 0.9.0-draft §5.5.8 requires a percentage basis to floor,
exactly, with no tolerance for a difference of one unit, and this bridge's cut
rounds up. §5.5.8 names the remedy for a rate finer than a whole percent:
state the charge that rate produced as a fixed basis against the same `base`.
It discloses strictly more than a percentage, because the caller reads the
charge itself instead of multiplying the base out, and the amount a caller
sees is unchanged.

The rule contradicted the family it belongs to. Agent SoW §5.5.6 already
requires a provider to disclose, on its own line and at cost, anything it
bought elsewhere and billed on. The operator taking a margin out of the same
total was the one party exempt from saying so. Agent SoW 0.7.0-draft §5.5.8
closes that gap at https://agentsow.com/spec.html#operator-fee, and this
section now follows it.

**The rule.** Wherever the bridge quotes or settles a price, any operator fee
inside that price MUST be disclosed as its own line carrying its amount and
the basis it was computed from.

1. A `PAYMENT_REQUIRED` refusal MUST carry `operator_fee` beside
   `price_credits`: an object with `amount` (the operator's cut, in the same
   denomination as `price_credits`), `basis` (the percentage or the fixed
   charge the amount was computed from), and `base` (the amount that basis
   was applied to). `price_credits` stays the retail total the caller pays.
2. Every entry of `accepted` quotes in its own denomination, so each entry
   that carries a fee MUST carry its own `operator_fee` in that
   denomination. An entry MUST NOT inherit another entry's fee line.
3. The settlement record or receipt for the charge MUST carry the same
   `operator_fee` line, with the amount actually taken, so the arithmetic is
   checkable after the fact. Both numbers are already in hand at settle time:
   the two legs send `rate` and `retail` together.
4. A refusal or a receipt that carries no `operator_fee` asserts that no
   operator fee is inside its total. A bridge that takes a fee and omits the
   line is not conformant.

```json
"operator_fee": { "amount": 1, "basis": { "kind": "fixed", "fixed": 1 },
                  "base": 5 }
```

The worked example: an owner's rate of 5 credits at a 10 percent markup. The
cut is 1 credit, rounded up from half a credit, and `price_credits` is 6. The
line states the cut as the fixed charge it is. Stating it as 10 percent of 5
would not close under §5.5.8, because 10 percent of 5 floors to 0.

**What this reveals, stated rather than left to be discovered.** Disclosing
the operator's fee reveals what the attached agent's owner receives, because
the retail total minus the fee is the owner's net. That is the direct
consequence of the rule, not an oversight in it. An owner unwilling to have
its wholesale rate readable by callers cannot sell through a bridge that
takes a disclosed fee, and the remedy is to change the arrangement rather
than to omit the line. As stated above, the rate was already recoverable from
`markup_pct` and the quoted total. What changes is that the caller is told
instead of being left to work it out.

Where an agent sells under its own SKU the operator takes nothing, there is
no fee, and no `operator_fee` line appears. This section binds the resale
path, which is the path the bridge fronts.

In the terms of the Agent SoW enforcement gradient (§3 of that
specification), disclosure here is `enforced`: the bridge builds the quote
and settles the charge, and the caller can check the line against bytes it
already holds.

## 10. Outbound Attachment Lifecycle

1. **Attach:** the operator supplies the A2A endpoint URL (and optional
   static auth headers). The bridge fetches the agent card, verifies JWS
   signatures when present (§2.1 rule 5), registers the card and manifest as
   §8.2 says under a hosted identity it mints, and starts answering for it.
2. **Serve:** a request frame addressed to the hosted identity is sent to the
   remote as the same A2A operation, with `payload.a2a.params` unchanged as
   the request object, over the remote's JSON-RPC or HTTP+JSON interface. The
   frame's `meta.a2a` service parameters become HTTP headers. The remote's
   result or error comes back unchanged in a respond frame signed by the
   hosted identity (§7.1). A streaming answer's events become respond frames
   on `mesh.task.{taskId}.stream`, each with the request frame's `id` as
   `streamId`, numbered by `seq`, and ended with `final: true` when the
   remote's stream ends at a terminal state or with a Message, as binding §8
   says. As the hosted agent's node, the bridge also publishes each status and
   artifact update event on `mesh.task.{taskId}.update`, so the task store
   sees it (binding §5). A remote Task id that is not a single subject token
   cannot name those subjects, so the bridge refuses that answer with
   `InvalidAgentResponseError`. The offering extension's key passes
   unchanged; while the transition window is open the bridge also sets
   `message.metadata["agentmesh.offering"]` to the same offering, so that a
   chain through an older bridge still routes.
3. **Reading Tasks:** the remote server sees every mesh caller as the one
   bridge, so it cannot apply binding §10's rule itself. The bridge MUST
   record which mesh identity created each remote Task, from the first answer
   that carried the Task's id, and MUST answer `TaskNotFoundError` to any other
   identity's `GetTask`, `CancelTask`, `SubscribeToTask` or push configuration
   operation on it. It MUST filter a `ListTasks` result to the requesting
   identity's Tasks.
4. **Presence:** the bridge SHOULD health-check the remote (card re-fetch or
   HTTP HEAD) and drive the hosted agent's presence heartbeat from the result:
   healthy, the heartbeat continues; unreachable, the heartbeat stops and the
   agent goes `offline` naturally (SPEC.md §9.6).
5. **Refresh:** on card re-fetch, changes are classified by what they can do
   to whoever approved the original card. Cosmetic changes (names,
   descriptions, versions) MAY be absorbed and re-registered silently. A
   changed skill set or capability declaration MUST NOT be republished
   without re-approval: the attachment keeps serving the approved card while
   the change is held for review. A changed endpoint MUST suspend the
   attachment (deregister, stay off the mesh) until re-approved, because
   approval of "forward to A" is not approval of "forward to B". On
   re-approval, previously chosen skill exposures persist only where the new
   card still declares them; newly declared card skills are not exposed until
   chosen.
6. **Detach:** deregister the hosted agent and forget the minted identity.

## 11. Out of Scope (This Version)

Stated so nobody discovers them the hard way: the A2A gRPC binding; push
notification configurations in the outbound direction (a bridge answers them
`PushNotificationNotSupportedError` for an attached server); streaming
operations that carry a signed frame (EXT-14 §3); and OAuth flows on either
leg except PACT's delegated authority on the inbound leg (§14.8).

## 12. Conformance

An implementation may claim conformance with this mapping if it implements:
§2 (node model and trust rules 1 and 2, plus 3 to 5 where applicable), §3,
§4, §5, §6, §7 (including `data.agentmesh_code` on channel errors), §8
including the §8.3 marker, §9, §9.2 where it charges a fee, and, if it
implements the outbound direction, §10 steps 1, 2, 3 and 6. Inbound-only and
outbound-only implementations are both valid; each MUST document which
direction it provides. An implementation MAY implement either A2A binding or
both (§3, §13), and MUST document which. A bridge that serves PACT (§14)
claims PACT Identity conformance by passing `conformance/pact-identity.json`
for the Provider role, and PACT Delegated by also passing
`conformance/pact-delegated.json`. A bridge that lists Agent Messaging over
A2A in its cards implements EXT-14 §2 to §11.

Two fixture sets apply, and an implementation reads both in its own tests:

- `conformance/a2a-binding.json` is the binding's set (binding §15). Each
  operation appears twice, as frames over the binding and as the same call
  through a bridge's HTTP+JSON interface, and the A2A objects must agree. It
  also covers every error of §7.1, a Part by reference, a stream resumed
  after a drop, a long Task, the four budget outcomes, cancel reasons,
  offering routing with the older keys, and the refusal of a 0.4.0 frame that
  carries `task_id`. `conformance/lib/check-a2a-binding.mjs` checks it.
- `conformance/a2a-bridge.json` is this mapping's and EXT-14's set: signed
  and unsigned callers, a forged frame, the states in A2A's spelling, the
  states of 0.3.0 agents with `exhausted` and the budget pause, an answer on
  an existing Task, the knock and the reading of a queued acknowledgement, the
  budget's older form, and readable text.
  `conformance/lib/check-a2a-bridge-fixture.mjs` checks it.

`conformance/cross-transport/` holds runs of one quote over a broker, email
and this bridge with the same checks, recorded on wire version 0.3.0.

## 13. The HTTP+JSON Binding

The bridge serves the A2A 1.0 HTTP+JSON binding (A2A §11) inbound, beside
JSON-RPC. Both reach the same operations with the same admission (§9), the
same exposure rule (§2.1 rule 4), the same offering routing (§4.5) and the
same Parts (§6).

### 13.1 Routes

The interface URL is `https://<bridge-host>/agents/<agent-id>`. Paths are
relative to it. Every route passes through to the agent as §4.1 says.

| Method and path | Operation | Answer |
|---|---|---|
| `POST message:send` | `SendMessage` | `200`, `{"message": ...}` or `{"task": ...}` |
| `POST message:stream` | `SendStreamingMessage` | `200`, `text/event-stream`; each `data:` line is one A2A `StreamResponse` object with no JSON-RPC wrapper (§4.4) |
| `GET tasks/{id}` | `GetTask` | `200`, a `Task` |
| `GET tasks` | `ListTasks` | `200`, a `ListTasksResponse` |
| `POST tasks/{id}:cancel` | `CancelTask` | `200`, a `Task` |
| `POST tasks/{id}:subscribe` | `SubscribeToTask` | `200`, `text/event-stream` (§4.4) |
| `POST tasks/{id}/pushNotificationConfigs` | `CreateTaskPushNotificationConfig` | `200`, the configuration |
| `GET tasks/{id}/pushNotificationConfigs/{configId}` | `GetTaskPushNotificationConfig` | `200`, the configuration |
| `GET tasks/{id}/pushNotificationConfigs` | `ListTaskPushNotificationConfigs` | `200`, the configurations |
| `DELETE tasks/{id}/pushNotificationConfigs/{configId}` | `DeleteTaskPushNotificationConfig` | `200` |
| `GET extendedAgentCard` | `GetExtendedAgentCard` | `200`, an `AgentCard` |

Any of them may instead answer an A2A error (§7.1, §13.3). A path that is
none of these answers `404`, and a known path with the wrong method answers
`405`, each with no A2A body. A path segment may arrive with its colon
percent-encoded (`message%3Asend`); the bridge decodes it before matching.

### 13.2 Bodies and headers

- Requests and responses are the JSON form of A2A's Protocol Buffer messages
  (A2A §5.5): camelCase fields, and enums by their names, such as `ROLE_USER`,
  `ROLE_AGENT` and the `TASK_STATE_*` names of §5.1. This is the same JSON
  form the JSON-RPC interface and the binding use, so an object read on one
  is byte for byte what the others carry.
- Responses carry `Content-Type: application/a2a+json`. Requests may send
  `application/a2a+json` or `application/json`.
- `A2A-Version` may come as a header or as an `A2A-Version` query parameter.
  `1.0` is served. A request with no version is served as `1.0`, because this
  interface declares only `1.0`. Any other value is refused with
  `VERSION_NOT_SUPPORTED`. (A2A §3.6.2 reads an empty version as 0.3; the
  bridge's HTTP+JSON interface never offered 0.3, so there is nothing to
  serve under that reading.)
- Admission is §9's: `Authorization: Bearer <key>`.

### 13.3 Errors

Errors use the `google.rpc.Status` JSON form (A2A §11.6, AIP-193): `code`
repeats the HTTP status, `status` is the canonical code name, `message` is
for a person, and `details[0]` is a `google.rpc.ErrorInfo` with the reason.
A client reads the reason, never the status alone.

```json
{ "error": { "code": 404, "status": "NOT_FOUND", "message": "Task not found",
  "details": [ { "@type": "type.googleapis.com/google.rpc.ErrorInfo",
    "reason": "TASK_NOT_FOUND", "domain": "a2a-protocol.org",
    "metadata": {} } ] } }
```

An A2A error from the agent takes the reason and HTTP status of §7.1's
table, and this `status`:

| HTTP | `status` |
|---|---|
| 400, for `ContentTypeNotSupportedError` and `InvalidParamsError` | `INVALID_ARGUMENT` |
| 400, for the other A2A errors | `FAILED_PRECONDITION` |
| 404 | `NOT_FOUND` |
| 500 | `INTERNAL` |

The reason is the A2A error's name in upper snake case without the `Error`
suffix, as A2A §11.6 forms it. The A2A error's data travels as A2A §11.6
allows: its members whose values are strings in `details[0].metadata`, and
the whole data object as a further `details` entry,
`{"@type": "type.googleapis.com/google.protobuf.Struct", "value": {...}}`, so
nothing in it is lost. A channel error (§7.2)
is the reason `INTERNAL` with the HTTP status §7.2 names and the Agent
Messaging code in `details[0].metadata.agentmesh_code`, and its `status` is
the one for that HTTP status:

| HTTP | `status` |
|---|---|
| 401 | `UNAUTHENTICATED` |
| 403 | `PERMISSION_DENIED` |
| 413 | `INVALID_ARGUMENT` |
| 429 | `RESOURCE_EXHAUSTED` |
| 500 | `INTERNAL` |
| 502 | `UNAVAILABLE` |
| 504 | `DEADLINE_EXCEEDED` |

The gateway's own refusals (§9.1) are not A2A errors. They use the same
envelope with `domain: "agentmesh.ai"` and the gateway code as the reason:
`UNAUTHORIZED` (401, `UNAUTHENTICATED`, with `WWW-Authenticate`),
`RATE_LIMITED` (429, `RESOURCE_EXHAUSTED`, with `Retry-After`),
`PAYMENT_REQUIRED` (402, `FAILED_PRECONDITION`, with §9.1's fields in
`metadata`), `MESH_ONLY` (403, `PERMISSION_DENIED`) and `AGENT_UNAVAILABLE`
(404, `NOT_FOUND`).
