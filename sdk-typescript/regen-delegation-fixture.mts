// Writes conformance/delegation.json (SPEC §4.11): a delegation, an approval,
// a place request and a direct delegated envelope, each really signed, from
// published test seeds. Run once with `npx tsx regen-delegation-fixture.mts`
// when the format changes, with a spec change alongside; the fixture is the
// authority the tests hold the SDK to.
import { writeFileSync, readFileSync } from "node:fs";
import { canonicalJSON, keyPairFromSeed } from "./src/internal/identity.js";
import { createEnvelope } from "./src/internal/envelope-builder.js";
import {
  APPROVAL_SIG_PREFIX,
  DELEGATION_SIG_PREFIX,
  PLACE_REQUEST_SIG_PREFIX,
  actDigest,
  signApproval,
  signDelegatedEnvelope,
  signDelegation,
  signPlaceRequest,
} from "./src/delegation.js";

const tags = JSON.parse(readFileSync("../conformance/signature-tags.json", "utf8"));
const AGENT_SEED: string = tags.identities.sender_seed;
// A second published test seed, used only here, for the place.
const PLACE_SEED = "SUAKUHTBUGFZ3NORTJZZBQUZCETUDR5SUPVOUVYRSO7ZU5JJNZNH2POCWE";

const agent = keyPairFromSeed(AGENT_SEED);
const place = keyPairFromSeed(PLACE_SEED);

const delegation = signDelegation(
  {
    id: "dlg_vector_1",
    agent: agent.getPublicKey(),
    place: { id: "machine-vector", key: place.getPublicKey(), kind: "machine", label: "JEFF-LAPTOP" },
    scopes: ["read", "everyday"],
    always_on: true,
    issued_at: "2026-09-27T10:00:00.000Z",
    expires_at: "2026-12-26T10:00:00.000Z",
  },
  agent,
);
const { sig: _d, ...delegationBody } = delegation;

const act = { kind: "accept_quote", job: "42", price: { amount: 1200, currency: "USD" } };
const approval = signApproval(
  {
    agent: agent.getPublicKey(),
    delegation: delegation.id,
    act: { kind: "accept_quote", digest: await actDigest(act), summary: "Accept the quote on job 42 for 12.00 USD" },
    method: "passkey",
    approved_at: "2026-09-27T10:42:00.000Z",
    expires_at: "2026-09-27T10:52:00.000Z",
  },
  agent,
);
const { sig: _a, ...approvalBody } = approval;

const placeRequest = { delegation: delegation.id, ts: "2026-09-27T10:41:00.000Z", nonce: "n-vector-1", act: { tool: "reply", arguments: { message: "m1", text: "Yes, Thursday works." } } };
const placeRequestSig = signPlaceRequest(placeRequest, place);

const env = createEnvelope({
  type: "request",
  from: agent.getPublicKey(),
  to: tags.identities.recipient,
  payload: { offering: "chat", input: { text: "hello from the laptop" } },
});
env.id = "0192f0aa-0000-7000-8000-000000000001";
env.ts = "2026-09-27T10:41:30.000Z";
env.trace = { trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b7", parent_span_id: null };
const direct = signDelegatedEnvelope(env, delegation, place);

const fixture = {
  comment:
    "SPEC.md 4.11 fixture: one agent, many places. The delegation and the approval are signed by the AGENT key over their prefix + the canonical JSON of the object minus `sig` (base64url). The place request is signed by the PLACE key over its prefix + the canonical JSON of the request. The direct envelope is `from` the agent, carries the delegation in meta.delegation, and is signed by the PLACE key over the ordinary envelope signed bytes (SPEC.md 5.3); a receiver that does not implement 4.11 refuses it as IDENTITY_MISMATCH. THE FIXTURE IS THE AUTHORITY.",
  version: 1,
  spec: "SPEC.md 4.11",
  identities: {
    agent_seed: AGENT_SEED,
    agent: agent.getPublicKey(),
    place_seed: PLACE_SEED,
    place: place.getPublicKey(),
    comment: "Published test seeds. The agent is the sender of signature-tags.json.",
  },
  delegation: { signed_bytes_prefix: DELEGATION_SIG_PREFIX, canonical: canonicalJSON(delegationBody), signed: delegation },
  approval: { signed_bytes_prefix: APPROVAL_SIG_PREFIX, act, canonical: canonicalJSON(approvalBody), signed: approval },
  place_request: { signed_bytes_prefix: PLACE_REQUEST_SIG_PREFIX, request: placeRequest, canonical: canonicalJSON(placeRequest), sig: placeRequestSig },
  direct_envelope: { act: "send", now: "2026-09-27T10:41:30.000Z", envelope: direct },
  refusals: {
    comment: "Each case is the direct envelope above changed as described; the verdict is the §4.11 reason.",
    cases: [
      { change: "the place signed out (its key revoked)", reason: "delegation_revoked" },
      { change: "checked at 2026-12-27T00:00:00Z", reason: "delegation_expired" },
      { change: "act accept_quote with no approval", reason: "approval_required" },
      { change: "delegation.scopes set to [read] (signature no longer verifies)", reason: "delegation_invalid" },
    ],
  },
};
writeFileSync("../conformance/delegation.json", JSON.stringify(fixture, null, 2) + "\n");
console.log("wrote conformance/delegation.json");
