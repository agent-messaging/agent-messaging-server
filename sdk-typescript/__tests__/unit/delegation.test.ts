// One agent, many places (SPEC §4.11), held to conformance/delegation.json.
// THE FIXTURE IS THE AUTHORITY: when a case here fails, fix src/delegation.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import { canonicalJSON, fromB64Url, keyPairFromSeed, verifyEnvelopeSig } from "../../src/internal/identity.js";
import {
  APPROVAL_SIG_PREFIX,
  DELEGATION_SIG_PREFIX,
  PLACE_REQUEST_SIG_PREFIX,
  isCommittingAct,
  scopeCovers,
  signDelegation,
  verifyApproval,
  verifyDelegatedEnvelope,
  verifyDelegation,
  verifyPlaceRequest,
  viaOf,
  type Delegation,
} from "../../src/delegation.js";
import type { Envelope } from "../../src/types/envelope.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "..", "..", "..", "conformance", "delegation.json"), "utf8"));
const enc = new TextEncoder();
const NOW = new Date(fx.direct_envelope.now);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("§4.11 fixture bytes", () => {
  it("the delegation is signed by the agent over the tagged canonical bytes, and only those", () => {
    const b = fx.delegation;
    expect(b.signed_bytes_prefix).toBe(DELEGATION_SIG_PREFIX);
    const { sig, ...rest } = b.signed;
    expect(canonicalJSON(rest)).toBe(b.canonical);
    const pub = nkeys.fromPublic(fx.identities.agent);
    expect(pub.verify(enc.encode(b.signed_bytes_prefix + b.canonical), fromB64Url(sig))).toBe(true);
    expect(pub.verify(enc.encode(b.canonical), fromB64Url(sig))).toBe(false);
    expect(verifyDelegation(b.signed, { now: NOW })).toEqual({ ok: true });
  });

  it("the approval is signed by the agent and names the act's digest", async () => {
    const b = fx.approval;
    expect(b.signed_bytes_prefix).toBe(APPROVAL_SIG_PREFIX);
    const { sig: _s, ...rest } = b.signed;
    expect(canonicalJSON(rest)).toBe(b.canonical);
    const ok = await verifyApproval(b.signed, {
      agent: fx.identities.agent, delegation: fx.delegation.signed.id, act: b.act, now: new Date("2026-09-27T10:45:00.000Z"),
    });
    expect(ok).toEqual({ ok: true });
    const other = await verifyApproval(b.signed, {
      agent: fx.identities.agent, delegation: fx.delegation.signed.id, act: { ...b.act, job: "43" }, now: new Date("2026-09-27T10:45:00.000Z"),
    });
    expect(other).toMatchObject({ ok: false, reason: "approval_required" });
  });

  it("the place request verifies against the place key and not the agent key", () => {
    const b = fx.place_request;
    expect(b.signed_bytes_prefix).toBe(PLACE_REQUEST_SIG_PREFIX);
    expect(canonicalJSON(b.request)).toBe(b.canonical);
    expect(verifyPlaceRequest(b.request, fx.identities.place, b.sig)).toBe(true);
    expect(verifyPlaceRequest(b.request, fx.identities.agent, b.sig)).toBe(false);
    expect(verifyPlaceRequest({ ...b.request, nonce: "other" }, fx.identities.place, b.sig)).toBe(false);
  });
});

describe("the direct delegated envelope", () => {
  const env = (): Envelope => clone(fx.direct_envelope.envelope);

  it("is from the agent and refused by a receiver that does not implement §4.11", () => {
    expect(env().from).toBe(fx.identities.agent);
    expect(verifyEnvelopeSig(env())).toBe(false);
  });

  it("verifies for an everyday act and names the place", async () => {
    const out = await verifyDelegatedEnvelope(env(), { act: "send", now: NOW });
    expect(out.ok).toBe(true);
    expect(out.place?.label).toBe("JEFF-LAPTOP");
  });

  it("is refused once the place is signed out", async () => {
    const out = await verifyDelegatedEnvelope(env(), { act: "send", now: NOW, isRevoked: (k) => k === fx.identities.place });
    expect(out).toMatchObject({ ok: false, reason: "delegation_revoked" });
    const byId = await verifyDelegatedEnvelope(env(), { act: "send", now: NOW, isDelegationRevoked: () => true });
    expect(byId).toMatchObject({ ok: false, reason: "delegation_revoked" });
  });

  it("is refused after the delegation expires", async () => {
    const out = await verifyDelegatedEnvelope(env(), { act: "send", now: new Date("2026-12-27T00:00:00Z") });
    expect(out).toMatchObject({ ok: false, reason: "delegation_expired" });
  });

  it("asks for an approval before a committing act", async () => {
    const out = await verifyDelegatedEnvelope(env(), { act: "accept_quote", request: fx.approval.act, now: NOW });
    expect(out).toMatchObject({ ok: false, reason: "approval_required" });
  });

  it("refuses a delegation whose scopes were edited after signing", async () => {
    const e = env();
    (e.meta!.delegation as Delegation).scopes = ["read"];
    const out = await verifyDelegatedEnvelope(e, { act: "send", now: NOW });
    expect(out).toMatchObject({ ok: false, reason: "delegation_invalid" });
  });

  it("refuses an envelope another key signed", async () => {
    const e = env();
    e.payload = { offering: "chat", input: { text: "changed" } };
    const out = await verifyDelegatedEnvelope(e, { act: "send", now: NOW });
    expect(out).toMatchObject({ ok: false, reason: "delegation_invalid" });
  });
});

describe("the key holder's stamp (form 1)", () => {
  it("stamps meta.via under the caller's own meta, signed by the agent key", async () => {
    const { AgentMesh } = await import("../../src/mesh.js");
    const kp = keyPairFromSeed(fx.identities.agent_seed);
    const m = Object.create(AgentMesh.prototype) as InstanceType<typeof AgentMesh> & Record<string, unknown>;
    Object.assign(m, { kp, agentId: kp.getPublicKey(), outgoingMeta: null });
    const build = (meta?: Record<string, unknown>) =>
      (m as unknown as { newEnvelope(p: unknown): Envelope }).newEnvelope({ type: "request", from: kp.getPublicKey(), to: fx.identities.place, payload: {}, meta });
    expect(build().meta?.via).toBeUndefined();
    let via: Record<string, unknown> | undefined = { delegation: "d1", place: "ChatGPT", kind: "connector" };
    m.setOutgoingMeta(() => (via ? { via } : undefined));
    const e = build({ trace_note: "x" });
    expect(e.meta).toEqual({ via, trace_note: "x" });
    expect(verifyEnvelopeSig(e)).toBe(true);
    expect(build({ via: "caller wins" }).meta?.via).toBe("caller wins");
    via = undefined;
    expect(build().meta).toBeUndefined();
  });
});

describe("scopes and committing acts", () => {
  it("never covers a committing act, whatever the scopes say", () => {
    expect(isCommittingAct("accept_quote")).toBe(true);
    expect(isCommittingAct("approve_deploy")).toBe(true);
    expect(isCommittingAct("send")).toBe(false);
    expect(scopeCovers(["everyday"], "accept_quote")).toBe(false);
    expect(scopeCovers(["everyday"], "send")).toBe(true);
    expect(scopeCovers(["read"], "read_inbox")).toBe(true);
    expect(scopeCovers(["read"], "send")).toBe(false);
  });

  it("refuses to sign a delegation for another agent or with a committing scope", () => {
    const agent = keyPairFromSeed(fx.identities.agent_seed);
    const body = { ...clone(fx.delegation.signed) } as Delegation;
    delete (body as { sig?: string }).sig;
    expect(() => signDelegation({ ...body, agent: fx.identities.place }, agent)).toThrow();
    expect(() => signDelegation({ ...body, scopes: ["committing" as never] }, agent)).toThrow();
  });

  it("reads meta.via as a detail, never as a sender", () => {
    expect(viaOf({ meta: { via: { delegation: "d1", place: "ChatGPT", kind: "connector" } } })).toEqual({ delegation: "d1", place: "ChatGPT", kind: "connector" });
    expect(viaOf({ meta: {} })).toBeNull();
  });
});
