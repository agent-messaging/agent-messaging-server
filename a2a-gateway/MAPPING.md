# The A2A gateway: normative mapping between Agent Messaging and A2A

**Version:** 0.8.0-draft
**Status:** Working Draft
**Date:** 2026-07-14
**Revised:** 2026-10-29 (see §15)
**Applies to:** Agent Messaging 0.2 (SPEC.md) · Agent2Agent (A2A) Protocol v1.0, JSON-RPC and HTTP+JSON bindings · PACT 1.0 (§14)

> This document specifies the translation between Agent Messaging and the
> A2A protocol. It is the normative artifact: any bridge implementation — ours or
> a third party's, in any language, against any Agent Messaging binding — that follows
> these tables is interoperable. The reference implementation lives in
> `a2a-gateway/`.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted
as described in RFC 2119.

---

## 1. Purpose

A2A and AgentMesh occupy adjacent layers (SPEC.md §1.3). A2A assumes both
parties are HTTP endpoints: it defines the conversation (messages, tasks,
agent cards) between two agents that can already reach each other. AgentMesh
defines the channel for agents that have no URL — reach through firewalls,
signed identity, presence, and events over a single outbound connection.

The bridge is where the two meet. It makes both statements true at once:

- **Inbound:** a stock A2A client (JSON-RPC over HTTPS) can call any
  bridge-exposed mesh agent, with zero AgentMesh code.
- **Outbound:** any A2A server on the public web can appear on a mesh as a
  discoverable, addressable agent, with zero changes to that server.

Because AgentMesh's task model was designed with full A2A state parity
(SPEC.md §7), the mapping is mechanical. This document pins it down so it
stays mechanical.

## 2. The Bridge Is a Node

The bridge is not a new protocol concept. It is an AgentMesh **node**
(SPEC.md §4): it holds one credentialed connection to a mesh server and
vouches for hosted agents that do not hold their own credentials. Both bridge
directions are instances of that one concept:

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
A caller that does hold a key carries its own signed envelope across the leg
instead (EXT-14, Agent Messaging over A2A): the bridge relays it unchanged and
signs nothing, and the rules below do not apply to it. For bridged traffic:

1. A bridge MUST sign bridged envelopes with the hosted identity it minted,
   under its own node vouch. It MUST NOT present bridged traffic as
   natively signed by the external party.
2. Bridged agents MUST carry the bridge extension marker in their manifest
   (§8 below) so discovery consumers can distinguish bridged from native
   agents.
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

- The bridge targets **A2A v1.0** over two bindings: the **JSON-RPC
  binding** (A2A §9: PascalCase methods, JSON-RPC 2.0 over HTTPS,
  Server-Sent Events for streaming) and, from 0.3.0-draft, the **HTTP+JSON
  binding** (A2A §11), specified in §13 below.
- Generated agent cards MUST declare both interfaces in
  `supportedInterfaces`:
  `{"protocolBinding": "JSONRPC", "protocolVersion": "1.0"}` at
  `.../agents/<agent-id>/rpc` and
  `{"protocolBinding": "HTTP+JSON", "protocolVersion": "1.0"}` at
  `.../agents/<agent-id>`. A client picks by binding and version, not by
  position.
- Requests carrying an `A2A-Version` header the bridge does not support MUST
  receive `VersionNotSupportedError` (`-32009` on JSON-RPC, reason
  `VERSION_NOT_SUPPORTED` on HTTP+JSON). PACT routes are the one exception
  (§14.7).
- The A2A gRPC binding is out of scope for this version.

## 4. Method Mapping

### 4.1. Implemented Methods (Inbound)

| A2A JSON-RPC method | AgentMesh operation | Notes |
|---|---|---|
| `SendMessage` | `request` primitive (SPEC.md §6.3) | Result shape mirrors the responder's choice, §4.3 below |
| `SendStreamingMessage` | `stream` composed operation (SPEC.md §10.5) | SSE events per §4.4 below |
| `GetTask` | Bridge-local task record | The bridge is the mesh-side requester; it tracks Task state from response envelopes (SPEC.md §7) and serves `GetTask` from that record |
| `CancelTask` | `cancel` composed operation (SPEC.md §10.7) | `request` with `payload.offering: "task.cancel"` |

### 4.2. Unimplemented Methods (Inbound)

A bridge MUST answer these with the exact error shown, not with silence or
HTTP-level errors:

| A2A method | Response |
|---|---|
| `ListTasks` | `UnsupportedOperationError` (`-32004`) |
| `SubscribeToTask` | `UnsupportedOperationError` (`-32004`) |
| `CreateTaskPushNotificationConfig` (and Get/List/Delete) | `PushNotificationNotSupportedError` (`-32003`) |
| `GetExtendedAgentCard` | `ExtendedAgentCardNotConfiguredError` (`-32007`) |

Generated agent cards MUST declare `"pushNotifications": false` and
`"extendedAgentCard": false` in `capabilities`.

### 4.3. `SendMessage` Result Shape

AgentMesh responders choose between a **bare terminal response**
(`task_id: null`, work finished immediately) and a **Task response**
(deferred work) — SPEC.md §6.4. A2A results choose between a direct
**Message** and a **Task**. These correspond one-to-one:

| Mesh response | A2A `SendMessage` result |
|---|---|
| Bare terminal response (`task_id: null`, status `completed`) | `{"message": {...}}` — direct Message, role `ROLE_AGENT`, parts from `output` (§6) |
| Bare terminal response, status `failed` / `rejected` | JSON-RPC error (§7) |
| Task response (responder-assigned `task_id`, non-terminal) | `{"task": {...}}` — Task object, states per §5 |
| The queued acknowledgement with `delivered: true` or `paused: true` (SPEC.md §6.4a) | `{"task": {...}}` in `submitted`, whose id is the request id; a later reply that names the request completes it |
| The queued acknowledgement without either (the agent has not let the caller in) | `{"task": {...}}` in `auth-required` that says how to be let in (EXT-14 §9) |

### 4.4. `SendStreamingMessage` Event Mapping

Mesh streams (SPEC.md §11) map to the A2A task-lifecycle stream pattern:

| Mesh stream event | SSE `data:` payload |
|---|---|
| Stream opens (first chunk pending) | `{"task": {"id": ..., "status": {"state": "working"}}}` |
| `stream_chunk` (`final: false`) | `{"artifactUpdate": {"taskId": ..., "artifact": {"parts": [...]}}}` |
| `stream_chunk` (`final: true`) | artifact event for the final data, then `{"statusUpdate": {"taskId": ..., "status": {"state": "completed"}, "final": true}}` |
| Stream error / chunk-count mismatch (SPEC.md §11.6) | `InvalidAgentResponseError` (`-32006`), stream closed |

The bridge MUST verify stream-level authentication (SPEC.md §11.6), including
the final-chunk `chunk_count`, before emitting the terminal SSE event. A
truncated or tampered mesh stream MUST surface as `-32006`, never as a clean
completion.

### 4.5. Offering Routing (Inbound)

A2A messages are not offering-addressed; mesh requests are. ("Skill" below is
A2A's word for the card entries; each maps to a mesh offering, SPEC.md §8.5.)
The bridge resolves the target offering in this order:

1. `message.metadata["agentmesh.offering"]` — or its pre-rename spelling
   `agentmesh.skill`, accepted for the deprecation window — if present and declared by the
   target agent's manifest.
2. If the target agent declares exactly one offering, that offering.
3. Otherwise: `InvalidParamsError` (`-32602`) with a message listing the
   agent's offering IDs.

A metadata hint naming an undeclared offering MUST be rejected with
`-32602` (not forwarded to the agent's default handler).

## 5. Task-State Mapping

The state sets were identical by design (SPEC.md §7 mirrors A2A §4.1.3), and
only the spelling differs per A2A binding convention, with one exception:
Agent Messaging's `exhausted`, for work that stopped because its engagement's
cap was reached (SPEC.md §7.2), has no A2A state.

| AgentMesh state | A2A protobuf enum | A2A JSON string |
|---|---|---|
| `submitted` | `TASK_STATE_SUBMITTED` | `submitted` |
| `working` | `TASK_STATE_WORKING` | `working` |
| `input_required` | `TASK_STATE_INPUT_REQUIRED` | `input-required` |
| `auth_required` | `TASK_STATE_AUTH_REQUIRED` | `auth-required` |
| `completed` | `TASK_STATE_COMPLETED` | `completed` |
| `failed` | `TASK_STATE_FAILED` | `failed` |
| `canceled` | `TASK_STATE_CANCELED` | `canceled` |
| `rejected` | `TASK_STATE_REJECTED` | `rejected` |
| `exhausted` | `TASK_STATE_CANCELED`, with `"agentmesh.state": "exhausted"` in the Task's `metadata` | `canceled`, with the same `metadata` |

The mapping is total from Agent Messaging to A2A, and a bridge MUST NOT
invent, merge, or drop states. `exhausted` maps to `canceled` because it is
the one A2A state that means "stopped short of the objective, nobody's
fault": `completed` would claim the work was done, and SPEC.md §7.2 forbids
recording it as `failed`. The `metadata` member keeps the difference for a
caller that reads it. From A2A to Agent Messaging, `canceled` is always
`canceled`; a bridge never turns an A2A state into `exhausted`.

A caller reads a Task only when it asks, so its view can skip states, such as
`working` between `input-required` and `completed`. It applies what it reads
as SPEC.md §7.3.1 says. A caller's answer to an `input-required` Task is
carried to the mesh Task as EXT-14 §8 says.

## 6. Payload ↔ Parts Mapping

Mesh payloads are arbitrary JSON; A2A messages carry typed `parts`.

**A2A parts → mesh `input`:**

| Incoming parts | Mesh `input` |
|---|---|
| Exactly one DataPart | The DataPart's data object, as-is |
| One or more TextParts (no DataPart) | `{"text": "<parts joined by \n>"}` |
| TextParts + DataParts mixed | The first DataPart's object, with `{"text": ...}` merged in if absent |
| Any FilePart | `ContentTypeNotSupportedError` (`-32005`) — files are out of scope for this version |

**Mesh `output` → A2A parts:**

| Mesh output | Outgoing parts |
|---|---|
| `{"text": "<string>"}` and no other keys | One TextPart |
| Any other JSON value | One DataPart carrying the value |

This round-trips cleanly: a DataPart in produces the same object as mesh
input, and structured mesh output arrives as a DataPart.

## 7. Error Mapping

Mesh error codes (SPEC.md §12) map to A2A JSON-RPC errors as follows.
Unlisted mesh codes map to `-32603` (Internal error). The original mesh code
MUST be preserved in the JSON-RPC error's `data.agentmesh_code` field. A
budget refusal (`BUDGET_INSUFFICIENT`, `BUDGET_EXHAUSTED`) also keeps its
`details`, such as the estimate, in `data.details` (EXT-14 §11).

| AgentMesh error code | JSON-RPC code | A2A error type |
|---|---|---|
| `TASK_NOT_FOUND`, `TASK_EXPIRED` | `-32001` | TaskNotFoundError |
| `TASK_NOT_CANCELABLE`, `TASK_INVALID_TRANSITION` | `-32002` | TaskNotCancelableError |
| `CONTENT_TYPE_NOT_SUPPORTED` | `-32005` | ContentTypeNotSupportedError |
| `OFFERING_NOT_FOUND` (legacy `SKILL_NOT_FOUND`), `INPUT_INVALID`, `INVALID_QUERY` | `-32602` | Invalid params |
| `UNAUTHORIZED`, `TRANSPORT_PERMISSION_DENIED` | `-32603` + HTTP 401/403 | (transport-level auth failure) |
| `AGENT_UNAVAILABLE`, `AGENT_OVERLOADED`, `TRANSPORT_NO_RESPONDERS` | `-32603` + HTTP 502 | (upstream unavailable) |
| `TRANSPORT_TIMEOUT` | `-32603` + HTTP 504 | (upstream timeout) |
| `RATE_LIMITED` | `-32603` + HTTP 429 | (throttled) |
| `INVALID_ENVELOPE`, `IDENTITY_MISMATCH`, stream auth failure | `-32006` | InvalidAgentResponseError |
| all others | `-32603` | Internal error |

Outbound, the inverse applies: A2A errors received from a remote server map
back to mesh error objects with the A2A code preserved in `error.meta`.

## 8. Manifest ↔ Agent Card Mapping

### 8.1. Inbound: Mesh Manifest → Generated Agent Card

Served per exposed agent at
`https://<bridge-host>/agents/<agent-id>/.well-known/agent-card.json`.

| Manifest field (SPEC.md §8) | Agent card field (A2A §8.5) |
|---|---|
| `name` | `name` |
| `description` | `description` |
| `version` | `version` |
| `provider.name` / `provider.url` | `provider.organization` / `provider.url` |
| `id` (mesh public key) | carried in the interface URL path and in the bridge extension params |
| — | `supportedInterfaces`: `[{url: https://<bridge-host>/agents/<agent-id>/rpc, protocolBinding: "JSONRPC", protocolVersion: "1.0"}, {url: https://<bridge-host>/agents/<agent-id>, protocolBinding: "HTTP+JSON", protocolVersion: "1.0"}]` (§3, §13) |
| `offerings[].id/name/description/tags` | `skills[].id/name/description/tags` |
| `offerings[].examples[]` (`{input, output}` objects) | `skills[].examples[]` (each input serialized to a JSON string) |
| `offerings[].input_modes` / `output_modes` | `skills[].inputModes` / `outputModes` (default `["application/json", "text/plain"]`) |
| any offering with `streaming: true` | `capabilities.streaming: true` |
| — | `capabilities.pushNotifications: false`, `capabilities.extendedAgentCard: false` |
| bridge marker (§8.3) | `capabilities.extensions[]` entry |

Mesh `input_schema` / `output_schema` have no agent card equivalent (cards
declare media-type modes, not schemas). A bridge that implements Agent
Messaging over A2A carries them, with each offering's inputs and outputs, in
that extension's `params` (EXT-14 §10).

Where the agent published an Agent Descriptor (SPEC.md §8.13), the table
above yields to it: the card's description, version and skills are generated
from the Descriptor itself, the extension's `params` link to the Descriptor
with its digest, and the bridge serves the Descriptor's bytes there (EXT-14
§10). The manifest supplies only what the Descriptor does not hold.

### 8.2. Outbound: Agent Card → Mesh Manifest

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
| the JSON-RPC `supportedInterfaces` URL | `endpoint` |
| — | `id`: mesh public key minted and held by the bridge for this remote |
| — | `node`: the bridge node's vouch (SPEC.md §4.4) |
| — | bridge marker (§8.3) in `extensions` and `meta` |

Card `examples` (strings) are not converted to mesh `OfferingExample` objects;
they are dropped rather than guessed at.

### 8.3. The Bridge Marker

This is the A2A form of the general marker of SPEC.md §4.15 rule 4. An inbound
bridged envelope carries both: `meta.a2a_bridge` below, which receivers written
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

(`direction: "inbound"` marker appears in generated agent cards as the
corresponding `capabilities.extensions[]` entry instead, using the same
canonical URI with a `documentationUrl` pointing at the bridge documentation.)
The extension URI is registered in the AgentMesh extensions registry
(SPEC.md §17.5).

### 8.4. Messages for the Person (0.4.0)

SPEC.md §5.7 lets a sender mark a message for the person behind the
receiving agent, with `meta.audience: "person"`, and an agent declares that
it keeps §5.7's rules with the extension `mesh://extensions/audience/v1`. A2A
has no such mark of its own. Its extension mechanism carries one: an agent
card lists extensions in `capabilities.extensions[]`, and a message lists the
ones it uses in `extensions` and carries their data in `metadata`.

**The declaration.** A generated card (§8.1) lists the URI in
`capabilities.extensions[]` exactly when the exposed mesh agent's manifest
declares it. A bridged manifest (§8.2) declares the URI exactly when the
remote card lists it. A bridge MUST NOT add the declaration in either
direction on its own account.

**Inbound (A2A client to mesh agent).** An A2A message whose `extensions`
lists the URI and whose `metadata["agentmesh.audience"]` is `"person"` is
carried as a request marked for the person: the bridge signs it with the
caller's hosted identity and `meta.audience: "person"`, and signs the digest
of its readable text in `meta.readable_text` (Agent Messaging §5.8). The
message's text parts, joined, are its `payload.text`. A value that is not a
string is refused with `InvalidParamsError` (`-32602`). The bridge answers the
A2A caller with a Task in state `submitted` (§5) from its own task record
(§4.1, `GetTask`), since the mesh agent's person answers, if at all, later.
When a reply marked for a person arrives, the bridge completes that record
with the reply as a Message carrying `metadata["agentmesh.audience"]:
"person"`. Only the agent the message went to may complete it. The Message's
first part is the reply's readable text, generated from the signed reply
(Agent Messaging §5.8, EXT-14 §6), and the reply's envelope rides in the
Message's metadata under EXT-14's URI, so software that shows the text can
check it. The task is the bridge's own record of the exchange; no mesh Task
exists for it (SPEC.md §7.0).

**Outbound (mesh agent to remote A2A server).** The bridge is the receiving
node for the bridged agent, so §5.7's receiver rules bind it. When the remote
card lists the URI, the bridge forwards a marked request with the URI in the
message's `extensions` and `metadata["agentmesh.audience"]: "person"`, and
the remote server keeps the rules it declared. The forwarded message's first
part is the readable text generated from the sender's signed envelope (Agent
Messaging §5.8, EXT-14 §6). When the remote card does not
list it, the bridge MUST refuse the request with `AUDIENCE_NOT_SUPPORTED`
(SPEC.md §12.2) and forward nothing, even when the sender chose to send
anyway. A native receiver that does not know the mark still receives it under
the sender's signature; forwarding over HTTP would make the bridge the party
that drops it, and §5.7 has every carrier keep it.

| Mesh | A2A |
|---|---|
| manifest `extensions[]` entry `mesh://extensions/audience/v1` | card `capabilities.extensions[]` entry, same URI |
| `meta.audience: "person"` on a request or a reply | message `extensions` lists the URI; `metadata["agentmesh.audience"]: "person"` |
| `AUDIENCE_NOT_SUPPORTED` | `-32603` with `data.agentmesh_code: "AUDIENCE_NOT_SUPPORTED"` (§7) |

## 9. Inbound Caller Identity

| Caller presents | Hosted mesh identity |
|---|---|
| No credentials | Ephemeral per-session identity, sandbox-flagged; subject to the guest rate tier |
| A bridge API key (`Authorization: Bearer <key>`) | A stable identity minted at key creation, reused across calls |
| Its own signed envelope, under EXT-14 (with whatever credential the bridge requires) | None. The envelope travels on the caller's own signature, and the bridge relays it unchanged |

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
for them, and MUST restore that same identity — the same mesh public key —
after a restart or after the caller is evicted from any in-memory pool. An
identity re-minted per process is not stable; it merely looks stable to
whoever tries it twice in a row.

Two consequences follow, and they are the reason the rule is stated:

1. **The marker means something.** §2.1 rule 2's marker is only useful if the
   thing it marks keeps its name. The manifest an inbound caller identity
   registers MUST carry the §8.3 marker with `direction: "inbound"`, and it
   SHOULD be `unlisted`: the identity serves no offerings, so open discovery
   must not present it as an agent that answers requests.
2. **A record resolves afterwards.** An audit, activity or settlement row
   names a mesh identity. A bridge MUST be able to resolve a hosted caller
   identity back to the party that presented the credential after the process
   that minted it has exited — otherwise the row names a string.

What is persisted MUST NOT include anything a caller could present. The
caller's credential is a digest already (§9 above); the association MUST be
keyed by that digest or another non-reversible handle, never by the raw key.
The identity's own signing seed is secret and MUST be stored with the
protection any private key gets on that platform.

Every envelope a bridge sends on a caller's behalf MUST carry the §8.3
inbound marker in the envelope's `meta`, so a receiver reads the attribution
from something the bridge's signature covers rather than from a transport
header. The marker names the direction, the vouching node, the caller's
`caller_ref` — a stable opaque handle — and `caller_kind`. It MUST NOT carry
the caller's account: the envelope reaches whichever agent was addressed, and
a bridged caller must not be made more identifiable to strangers than a
mesh-native one. Resolving `caller_ref` to a party is the bridge operator's
lookup against the record, not a fact on the wire.

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
object: `price_credits` (the quoted price, which is the RETAIL price the
caller pays; the bridge resells the attached agent's work), an
`operator_fee` line disclosing the operator's cut inside that price per
§9.2, a typed `reason`
(`no_account` | `insufficient` | `ledger_unreachable`, with
`balance_credits` on `insufficient`), and `accepted` — an ARRAY of
settlement-method objects, each `{ method, amount, unit, ... }`. Every entry
quotes in its OWN denomination. The array is the extension point (SPEC.md
§1.3, payments): today one entry,
`{ method: "agentmesh-credits", amount, unit: "credit", url }`; an
x402-style entry (`{ method: "x402", amount, unit, chain, address }`) is the
intended second, and a consumer that reads the array needs no change when it
appears. Errors raised
by the remote agent are mapped per §4.2/§5 and carry that mapping's codes,
never these.

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

That cut is disclosed as a FIXED basis against the owner's rate, not as a
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

1. **Attach:** operator supplies the A2A endpoint URL (and optional static
   auth headers). The bridge fetches the agent card, verifies JWS signatures
   when present (§2.1 rule 5), converts per §8.2, mints a hosted identity, and
   registers it on the mesh.
2. **Serve:** mesh `request` envelopes addressed to the hosted identity are
   forwarded as `SendMessage` (blocking) or `SendStreamingMessage` (when the
   remote declares `capabilities.streaming` and the mesh requester asked to
   stream). The mesh offering ID MUST be carried in
   `message.metadata["agentmesh.offering"]` (with the pre-rename
   `agentmesh.skill` alongside for the deprecation window — the same keys §4.5
   reads inbound), so multi-skill remotes and bridge-to-bridge chains route
   correctly. Results
   map back per §4.3/§4.4 inverted.
3. **Presence:** the bridge SHOULD health-check the remote (card re-fetch or
   HTTP HEAD) and drive the hosted agent's presence heartbeat from the result:
   healthy → heartbeat continues; unreachable → heartbeat stops, the agent
   goes `offline` naturally (SPEC.md §9.6).
4. **Refresh:** on card re-fetch, changes are classified by what they can do
   to whoever approved the original card. Cosmetic changes (names,
   descriptions, versions) MAY be absorbed and re-registered silently. A
   changed skill set or capability declaration MUST NOT be republished
   without re-approval: the attachment keeps serving the approved card while
   the change is held for review. A changed JSON-RPC endpoint MUST suspend
   the attachment (deregister, stay off the mesh) until re-approved —
   approval of "forward to A" is not approval of "forward to B". On
   re-approval, previously chosen skill exposures persist only where the new
   card still declares them; newly declared card skills are not exposed until
   chosen.
5. **Detach:** deregister the hosted agent and forget the minted identity.

## 11. Out of Scope (This Version)

Stated so nobody discovers them the hard way: A2A push notifications
(webhooks), `ListTasks`/`SubscribeToTask`, extended agent cards, FileParts,
the gRPC binding, multi-turn `input-required` conversations in the outbound
direction (a remote A2A server that asks a mesh caller for more input: the
state maps, but the bridge does not yet relay the mesh caller's answer;
inbound, EXT-14 §8 carries an A2A caller's answer to a mesh agent, and PACT
conversations, §14, continue by `contextId`), and OAuth flows on either leg
except PACT's delegated authority on the inbound leg (§14.8).

## 12. Conformance

An implementation may claim conformance with this mapping if it implements:
§2 (node model + both trust rules 1–2, plus 3–5 where applicable), §3, the
§4.1 methods with §4.2 rejections, §5 totally, §6, §7 (including
`data.agentmesh_code` preservation), §8 including the §8.3 marker, §9.2 where
it charges a fee, and — if it implements the outbound direction — §10 steps
1, 2, and 5. Inbound-only and outbound-only implementations are both valid;
each MUST document which direction it provides. An implementation MAY
implement either A2A binding or both (§3, §13), and MUST document which. A
bridge that serves PACT (§14) claims PACT Identity conformance by passing
`conformance/pact-identity.json` for the Provider role, and PACT Delegated by
also passing `conformance/pact-delegated.json`. A bridge that lists Agent
Messaging over A2A in its cards implements EXT-14 §2 to §11.

`conformance/a2a-bridge.json` is the fixture set for this mapping and EXT-14:
signed and unsigned callers, a forged message, the state spellings with
`exhausted`, the answer on an existing task, the knock and the reading of a
queued acknowledgement, and readable text. An implementation reads it in its
own tests, and `conformance/lib/check-a2a-bridge-fixture.mjs` checks it
against reference readings. `conformance/cross-transport/` runs one quote
over a broker, email and this bridge with the same checks.

## 13. The HTTP+JSON Binding

From 0.3.0-draft the bridge serves the A2A 1.0 HTTP+JSON binding (A2A §11)
inbound, beside JSON-RPC. Both reach the same operations with the same
admission (§9), the same exposure rule (§2.1 rule 4), the same offering
routing (§4.5), the same payload mapping (§6) and the same task records.

### 13.1 Routes

The interface URL is `https://<bridge-host>/agents/<agent-id>`. Paths are
relative to it.

| Method and path | Operation | Answer |
|---|---|---|
| `POST message:send` | `SendMessage` (§4.3) | `200` `{"message": ...}` or `{"task": ...}` |
| `POST message:stream` | `SendStreamingMessage` (§4.4) | `200` `text/event-stream`; each `data:` line is one A2A `StreamResponse` object with no JSON-RPC wrapper |
| `GET tasks/{id}` | `GetTask` | `200` `Task`, or `TASK_NOT_FOUND` |
| `POST tasks/{id}:cancel` | `CancelTask` | `200` `Task`, or `TASK_NOT_FOUND` / `TASK_NOT_CANCELABLE` |
| `GET tasks` | `ListTasks` | `UNSUPPORTED_OPERATION` (§4.2) |
| `POST tasks/{id}:subscribe` | `SubscribeToTask` | `UNSUPPORTED_OPERATION` |
| `GET` or `POST tasks/{id}/pushNotificationConfigs`, `GET` or `DELETE tasks/{id}/pushNotificationConfigs/{configId}` | push configuration | `PUSH_NOTIFICATION_NOT_SUPPORTED` |
| `GET extendedAgentCard` | `GetExtendedAgentCard` | `EXTENDED_AGENT_CARD_NOT_CONFIGURED` |

A path that is none of these answers `404`, and a known path with the wrong
method answers `405`, each with no A2A body. A path segment may arrive with
its colon percent-encoded (`message%3Asend`); the bridge decodes it before
matching.

### 13.2 Bodies and headers

- Requests and responses are the JSON form of A2A's Protocol Buffer messages
  (A2A §5.5): camelCase fields, and enums by their names: `ROLE_USER` and
  `ROLE_AGENT`, and task states as `TASK_STATE_*` (§5's middle column), never
  the JSON-RPC route's lowercase spellings.
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
    "metadata": { "agentmesh_code": "TASK_NOT_FOUND" } } ] } }
```

| A2A error | `reason` | HTTP | `status` |
|---|---|---|---|
| Invalid parameters | `INVALID_PARAMS` | 400 | `INVALID_ARGUMENT` |
| `TaskNotFoundError` | `TASK_NOT_FOUND` | 404 | `NOT_FOUND` |
| `TaskNotCancelableError` | `TASK_NOT_CANCELABLE` | 400 | `FAILED_PRECONDITION` |
| `PushNotificationNotSupportedError` | `PUSH_NOTIFICATION_NOT_SUPPORTED` | 400 | `FAILED_PRECONDITION` |
| `UnsupportedOperationError` | `UNSUPPORTED_OPERATION` | 400 | `FAILED_PRECONDITION` |
| `ContentTypeNotSupportedError` | `CONTENT_TYPE_NOT_SUPPORTED` | 400 | `INVALID_ARGUMENT` |
| `InvalidAgentResponseError` | `INVALID_AGENT_RESPONSE` | 500 | `INTERNAL` |
| `ExtendedAgentCardNotConfiguredError` | `EXTENDED_AGENT_CARD_NOT_CONFIGURED` | 400 | `FAILED_PRECONDITION` |
| `VersionNotSupportedError` | `VERSION_NOT_SUPPORTED` | 400 | `FAILED_PRECONDITION` |
| Internal error | `INTERNAL` | 500 | `INTERNAL` |

Mesh errors map to these reasons through §7's table, read across: a mesh
code that §7 sends to `-32001` becomes `TASK_NOT_FOUND`, and so on, and
`-32603` becomes `INTERNAL` with the HTTP status §7 names (502, 504) where it
names one. The mesh code is kept in `details[0].metadata.agentmesh_code`.

The gateway's own refusals (§9.1) are not A2A errors. They use the same
envelope with `domain: "agentmesh.ai"` and the gateway code as the reason:
`UNAUTHORIZED` (401, `UNAUTHENTICATED`, with `WWW-Authenticate`),
`RATE_LIMITED` (429, `RESOURCE_EXHAUSTED`, with `Retry-After`),
`PAYMENT_REQUIRED` (402, `FAILED_PRECONDITION`, with §9.1's fields in
`metadata`), `MESH_ONLY` (403, `PERMISSION_DENIED`) and `AGENT_UNAVAILABLE`
(404, `NOT_FOUND`).

