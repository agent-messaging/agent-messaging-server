// §8.9 `sealing` — the default, and the compatibility promise it rests on.
//
// The whole design turns on one claim: **an agent registered before this field
// existed is not affected by any of it.** That claim is not a policy anybody
// has to remember, it is a consequence of the signal being a manifest field an
// older SDK never writes. The first describe block below is that claim, and it
// is the test to break if the design is ever loosened.
//
// The rest is the rule (what earns which posture), the sender's decision, and
// the receiver's enforcement.
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope, signManifest } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";
import {
  createEncryptionIdentity,
  isSealedPayload,
  openSealedPayload,
  sealPayloadTo,
} from "../../src/internal/sealed.js";
import { derivedSealing } from "../../src/internal/sealing-posture.js";
import type { Manifest, Offering, SealingPosture } from "../../src/types/manifest.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { SecurityWarning } from "../../src/types/options.js";

// ── the rule ────────────────────────────────────────────────────────────────

const KEY = createEncryptionIdentity();

const credentialOffering: Offering = {
  id: "file-a-claim",
  name: "File a claim",
  description: "File a claim on the caller's behalf",
  needs: [{ credential: "Colorado DMV", scope: "to file on your behalf" }],
};
const plainOffering: Offering = { id: "work", name: "work", description: "" };

describe("§8.9 the rule — a declaration about the work sets the posture", () => {
  it("an agent that declared nothing declares no posture", () => {
    expect(derivedSealing({ encryption_key: KEY.publicKey, offerings: [plainOffering] })).toBeUndefined();
  });

  it("asking a caller to sign in to a third party earns `required`", () => {
    expect(
      derivedSealing({ encryption_key: KEY.publicKey, offerings: [credentialOffering] }),
    ).toBe("required");
  });

  it("declaring an integration earns `preferred`", () => {
    expect(
      derivedSealing({
        encryption_key: KEY.publicKey,
        works_with: [{ service: "Salesforce" }],
        offerings: [plainOffering],
      }),
    ).toBe("preferred");
  });

  it("a credential need outranks an integration: the stronger signal wins", () => {
    expect(
      derivedSealing({
        encryption_key: KEY.publicKey,
        works_with: [{ service: "Salesforce" }],
        offerings: [credentialOffering],
      }),
    ).toBe("required");
  });

  it("no encryption key means no posture, however it was asked for", () => {
    for (const explicit of [undefined, "required", "preferred"] as const) {
      expect(
        derivedSealing({ offerings: [credentialOffering] }, explicit),
        `explicit=${explicit}`,
      ).toBeUndefined();
    }
  });

  it("an operator can decline a posture the rule would otherwise apply", () => {
    expect(
      derivedSealing({ encryption_key: KEY.publicKey, offerings: [credentialOffering] }, "none"),
    ).toBeUndefined();
  });

  it("a blank credential name is not a declaration", () => {
    expect(
      derivedSealing({
        encryption_key: KEY.publicKey,
        offerings: [{ id: "x", name: "x", description: "", needs: [{ credential: "   " }] }],
      }),
    ).toBeUndefined();
  });

  it("an empty works_with array is 'declared none', not a signal", () => {
    expect(
      derivedSealing({ encryption_key: KEY.publicKey, works_with: [], offerings: [plainOffering] }),
    ).toBeUndefined();
  });
});

// ── the harness ─────────────────────────────────────────────────────────────

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

/** A fake connection whose registry serves one manifest per agent id, and which
 *  records everything published. */
function makeConn(manifests: Manifest[] = []) {
  const registryKp = nkeys.createUser();
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const published: Array<{ subject: string; env: Envelope }> = [];
  const registered: Manifest[] = [];
  const conn = {
    published,
    registered,
    maxPayload: 1_000_000,
    publish: vi.fn((subject: string, data: Uint8Array) => {
      published.push({ subject, env: decodeUnverified(data) });
    }),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      let payload: unknown = { status: "registered" };
      if (subject.startsWith("mesh.registry.get.")) {
        payload = byId.get(subject.slice("mesh.registry.get.".length)) ?? null;
      } else if (subject === Subjects.REGISTRY_REGISTER) {
        registered.push(req.payload as Manifest);
      }
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: registryKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload,
            }),
            registryKp,
          ),
        ),
      };
    }),
    subscribe: vi.fn(() => ({ unsubscribe: () => {}, drain: async () => {} })),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {} },
    get isClosed() {
      return false;
    },
  };
  return conn;
}

/** A recipient's manifest, signed with its own §8.3 key claim so the sender's
 *  verification is the real one and not a stub. */
function recipientManifest(opts: {
  kp: ReturnType<typeof nkeys.createUser>;
  encryptionKey?: string;
  sealing?: SealingPosture;
  /** Break the §8.3 claim after signing, to prove "cannot verify" = "will not seal". */
  tamper?: boolean;
}): Manifest {
  const id = opts.kp.getPublicKey();
  const m: Manifest = {
    id,
    name: "vendor",
    description: "",
    version: "1.0.0",
    protocol_version: "0.2.0",
    endpoint: Subjects.agentInbox(id),
    endpoints: { inbox: Subjects.agentInbox(id) },
    capabilities: [],
    offerings: [plainOffering],
    node: {
      id,
      attestation: { node: id, agent: id, issued_at: "", expires_at: "", sig: "" },
    },
    ...(opts.encryptionKey ? { encryption_key: opts.encryptionKey } : {}),
    ...(opts.sealing ? { sealing: opts.sealing } : {}),
  };
  signManifest(m, opts.kp);
  if (opts.tamper) m.encryption_key = createEncryptionIdentity().publicKey;
  return m;
}

/** A caller that has already resolved the recipient's manifest (§6.4b: "when
 *  the manifest is at hand"), plus its captured security warnings. */
async function callerFor(manifest: Manifest, opts?: { encryptionSeed?: string }) {
  const conn = makeConn([manifest]);
  const warnings: SecurityWarning[] = [];
  const caller = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
    { onSecurityWarning: (w) => warnings.push(w), encryptionSeed: opts?.encryptionSeed },
  );
  openAgents.push(caller);
  await caller.getManifest(manifest.id);
  conn.published.length = 0;
  return { conn, caller, warnings };
}

/** Run request() far enough to capture the published request envelope. The
 *  fake connection never answers an agent inbox, so the send times out; the
 *  envelope it built is the observable. */
/** How many calls the connection's own request mock had seen when the
 *  request itself went out (sentInput). */
let callsBeforeSend = -1;

async function sentInput(
  caller: AgentMesh,
  agentId: string,
  input: unknown,
  config?: Parameters<AgentMesh["request"]>[3],
): Promise<unknown> {
  let captured: unknown;
  const conn = (caller as unknown as { conn: { request: ReturnType<typeof vi.fn> } }).conn;
  const original = conn.request;
  conn.request = vi.fn(async (subject: string, data: Uint8Array) => {
    if (subject.startsWith("mesh.agent.")) {
      callsBeforeSend = (original as { mock?: { calls: unknown[] } }).mock?.calls.length ?? -1;
      captured = (decodeUnverified(data).payload as { input?: unknown }).input;
      throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "no responder in this test");
    }
    return original(subject, data);
  });
  await caller.request(agentId, "work", input, { timeout_ms: 50, ...config }).catch(() => {});
  conn.request = original;
  return captured;
}

// ── the compatibility promise ───────────────────────────────────────────────

describe("§8.9 compatibility — an agent that never opted in is untouched", () => {
  it("a recipient with no `sealing` gets cleartext, even holding an encryption key", async () => {
    // This is the fleet's exact shape: agents publish an encryption_key so they
    // can be invited to sealed rooms, and their handlers have never opened a
    // sealed payload. Inferring a posture from the KEY rather than from a
    // declaration is the change that would have broken them.
    const kp = nkeys.createUser();
    const manifest = recipientManifest({ kp, encryptionKey: KEY.publicKey });
    const { caller } = await callerFor(manifest, { encryptionSeed: KEY.seed });
    const sent = await sentInput(caller, manifest.id, { records: "sensitive" });
    expect(isSealedPayload(sent)).toBe(false);
    expect(sent).toEqual({ records: "sensitive" });
  });

  it("a recipient with neither key nor posture gets cleartext and no warning", async () => {
    const kp = nkeys.createUser();
    const manifest = recipientManifest({ kp });
    const { caller, warnings } = await callerFor(manifest);
    const sent = await sentInput(caller, manifest.id, { hello: "world" });
    expect(sent).toEqual({ hello: "world" });
    expect(warnings).toEqual([]);
  });

  it("a recipient the caller never resolved gets cleartext: no lookup is added to the send path", async () => {
    const kp = nkeys.createUser();
    const manifest = recipientManifest({
      kp,
      encryptionKey: KEY.publicKey,
      sealing: "required",
    });
    const conn = makeConn([manifest]);
    const caller = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(caller);
    // No getManifest: the cache is cold. The send must NOT go and fetch one —
    // a registry round trip in front of every request would make a registry
    // blip a messaging outage. The recipient refuses it instead (below). (After
    // the target stayed silent, the SDK may ask whether it was stopped; that is
    // behind the send, never in front of it.)
    await sentInput(caller, manifest.id, { x: 1 });
    expect(callsBeforeSend).toBeGreaterThanOrEqual(0);
    expect(
      conn.request.mock.calls.slice(0, callsBeforeSend).some(([s]) => String(s).startsWith("mesh.registry.get.")),
    ).toBe(false);
  });

  it("a receiving agent that declared no posture still reads a cleartext request", async () => {
    const conn = makeConn();
    const agentKp = nkeys.createUser();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      agentKp,
      nkeys.createUser(),
    );
    openAgents.push(agent);
    const seen: unknown[] = [];
    agent.onRequest("work", (input) => {
      seen.push(input);
      return { ok: true };
    });
    await agent.register({ name: "plain", offerings: [plainOffering] });
    const reply = await deliver(agent, conn, agentKp.getPublicKey(), { note: "hello" });
    expect(seen).toEqual([{ note: "hello" }]);
    expect(reply.error).toBeUndefined();
    expect((reply.payload as { output?: unknown }).output).toEqual({ ok: true });
  });
});

/** Hand an agent one inbound request on its inbox and return the terminal
 *  respond (skipping the §6.4a accept, which is not the answer). */
async function deliver(
  agent: AgentMesh,
  conn: ReturnType<typeof makeConn>,
  agentId: string,
  input: unknown,
  senderKp = nkeys.createUser(),
): Promise<Envelope> {
  const env = signEnvelope(
    createEnvelope({
      type: "request",
      from: senderKp.getPublicKey(),
      to: agentId,
      payload: { offering: "work", input },
    }),
    senderKp,
  );
  const msg = {
    subject: Subjects.agentInbox(agentId),
    reply: "_INBOX.test",
    data: encode(env),
    respond: () => true,
  };
  await (agent as unknown as { handleInboxMessage(m: unknown): Promise<void> }).handleInboxMessage(msg);
  // §6.4 cutover: replies are PUBLISHED to the sender's inbox, so the fake's
  // publish record is where they land.
  const senderInbox = Subjects.agentInbox(senderKp.getPublicKey());
  const replies = conn.published.filter((p) => p.subject === senderInbox).map((p) => p.env);
  const terminal = replies.find(
    (r) => (r.payload as { status?: string } | undefined)?.status !== "accepted",
  );
  if (!terminal) throw new Error("no terminal respond");
  return terminal;
}

// ── the sender's decision ───────────────────────────────────────────────────

describe("§8.9 the sender — seals when asked, and never to a key nobody signed for", () => {
  it("`required` seals the input and names the caller's own key as reply_key", async () => {
    const kp = nkeys.createUser();
    const manifest = recipientManifest({
      kp,
      encryptionKey: KEY.publicKey,
      sealing: "required",
    });
    const mine = createEncryptionIdentity();
    const { caller } = await callerFor(manifest, { encryptionSeed: mine.seed });
    const sent = await sentInput(caller, manifest.id, { records: [1, 2, 3] });
    expect(isSealedPayload(sent)).toBe(true);
    const opened = openSealedPayload(sent as never, KEY.seed);
    expect(opened?.payload).toEqual({ records: [1, 2, 3] });
    expect(opened?.reply_key).toBe(mine.publicKey);
  });

  it("`preferred` seals too", async () => {
    const kp = nkeys.createUser();
    const manifest = recipientManifest({
      kp,
      encryptionKey: KEY.publicKey,
      sealing: "preferred",
    });
    const { caller } = await callerFor(manifest, { encryptionSeed: KEY.seed });
    expect(isSealedPayload(await sentInput(caller, manifest.id, { a: 1 }))).toBe(true);
  });

  it("`preferred` with an unverifiable key sends in the clear AND says so", async () => {
    const kp = nkeys.createUser();
    const manifest = recipientManifest({
      kp,
      encryptionKey: KEY.publicKey,
      sealing: "preferred",
      tamper: true,
    });
    const { caller, warnings } = await callerFor(manifest);
    const sent = await sentInput(caller, manifest.id, { a: 1 });
    expect(isSealedPayload(sent)).toBe(false);
    expect(warnings.map((w) => w.code)).toContain("sent_in_clear");
  });

  it("`required` with an unverifiable key refuses locally and publishes nothing", async () => {
    // The refusal belongs at home. Sending it to earn the same refusal remotely
    // would mean leaking the payload onto the wire first.
    const kp = nkeys.createUser();
    const manifest = recipientManifest({
      kp,
      encryptionKey: KEY.publicKey,
      sealing: "required",
      tamper: true,
    });
    const { conn, caller } = await callerFor(manifest);
    let thrown: MeshError | undefined;
    try {
      await caller.request(manifest.id, "work", { secret: true }, { timeout_ms: 50 });
    } catch (err) {
      thrown = err as MeshError;
    }
    expect(thrown?.code).toBe(ErrorCode.SEALING_REQUIRED);
    expect(thrown?.retryable).toBe(false);
    expect(conn.published).toEqual([]);
    expect(conn.request.mock.calls.filter(([s]) => String(s).startsWith("mesh.agent."))).toEqual([]);
  });

  it("config.seal false sends in the clear whatever the recipient declared", async () => {
    const kp = nkeys.createUser();
    const manifest = recipientManifest({
      kp,
      encryptionKey: KEY.publicKey,
      sealing: "required",
    });
    const { caller } = await callerFor(manifest, { encryptionSeed: KEY.seed });
    expect(isSealedPayload(await sentInput(caller, manifest.id, { a: 1 }, { seal: false }))).toBe(
      false,
    );
  });

  it("config.seal true seals to an agent that declared nothing", async () => {
    const kp = nkeys.createUser();
    const manifest = recipientManifest({ kp, encryptionKey: KEY.publicKey });
    const { caller } = await callerFor(manifest, { encryptionSeed: KEY.seed });
    expect(isSealedPayload(await sentInput(caller, manifest.id, { a: 1 }, { seal: true }))).toBe(
      true,
    );
  });

  it("config.seal true fails rather than downgrades when it cannot seal", async () => {
    const kp = nkeys.createUser();
    const manifest = recipientManifest({ kp });
    const { caller } = await callerFor(manifest);
    await expect(
      caller.request(manifest.id, "work", { a: 1 }, { timeout_ms: 50, seal: true }),
    ).rejects.toMatchObject({ code: ErrorCode.SEALING_REQUIRED });
  });
});

// ── the receiver's enforcement ──────────────────────────────────────────────

describe("§8.9 the receiver — opens the box, refuses the clear, answers sealed", () => {
  /** An agent that declares `required` by declaring a credential need. */
  async function vendorAgent() {
    const conn = makeConn();
    const agentKp = nkeys.createUser();
    const enc = createEncryptionIdentity();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      agentKp,
      nkeys.createUser(),
      { encryptionSeed: enc.seed, fenceInbound: false },
    );
    openAgents.push(agent);
    const seen: unknown[] = [];
    agent.onRequest("work", (input) => {
      seen.push(input);
      return { filed: true };
    });
    const manifest = await agent.register({
      name: "vendor",
      offerings: [{ ...credentialOffering, id: "work", name: "work" }],
    });
    return { conn, agent, agentKp, enc, seen, manifest };
  }

  it("register derives `required` from the credential need it already declared", async () => {
    const { manifest, enc } = await vendorAgent();
    expect(manifest.sealing).toBe("required");
    expect(manifest.encryption_key).toBe(enc.publicKey);
  });

  it("a cleartext request to a `required` agent is refused and never reaches the handler", async () => {
    const { conn, agent, agentKp, seen } = await vendorAgent();
    const reply = await deliver(agent, conn, agentKp.getPublicKey(), { records: "oops" });
    expect(reply.error?.code).toBe(ErrorCode.SEALING_REQUIRED);
    expect(reply.error?.retryable).toBe(false);
    expect(seen).toEqual([]);
  });

  it("a sealed request reaches the handler as plaintext and the answer comes back sealed", async () => {
    const { conn, agent, agentKp, enc, seen } = await vendorAgent();
    const senderKp = nkeys.createUser();
    const senderEnc = createEncryptionIdentity();
    // The responder resolves the sender's OWN published key before sealing the
    // answer to the reply_key it claimed, so the registry must know the sender.
    const senderManifest = recipientManifest({
      kp: senderKp,
      encryptionKey: senderEnc.publicKey,
    });
    (conn as unknown as { request: ReturnType<typeof vi.fn> }).request.mockImplementation(
      fakeRegistry({ [senderKp.getPublicKey()]: senderManifest }),
    );
    const sealed = sealPayloadTo({ records: [1, 2] }, enc.publicKey, senderEnc.publicKey);
    const reply = await deliver(agent, conn, agentKp.getPublicKey(), sealed, senderKp);
    expect(seen).toEqual([{ records: [1, 2] }]);
    const output = (reply.payload as { output?: unknown }).output;
    expect(isSealedPayload(output)).toBe(true);
    expect(openSealedPayload(output as never, senderEnc.seed)?.payload).toEqual({ filed: true });
  });

  it("a reply_key that disagrees with the sender's published key is refused, not honoured", async () => {
    // The whole point of resolveReplyKey: `reply_key` rides outside the box, so
    // honouring the name alone lets a sender have the answer encrypted to
    // somebody who is not it.
    const { conn, agent, agentKp, enc } = await vendorAgent();
    const senderKp = nkeys.createUser();
    const senderEnc = createEncryptionIdentity();
    const somebodyElse = createEncryptionIdentity();
    const senderManifest = recipientManifest({
      kp: senderKp,
      encryptionKey: senderEnc.publicKey,
    });
    (conn as unknown as { request: ReturnType<typeof vi.fn> }).request.mockImplementation(
      fakeRegistry({ [senderKp.getPublicKey()]: senderManifest }),
    );
    const sealed = sealPayloadTo({ records: [1] }, enc.publicKey, somebodyElse.publicKey);
    const reply = await deliver(agent, conn, agentKp.getPublicKey(), sealed, senderKp);
    expect(reply.error?.code).toBe(ErrorCode.SEALING_REQUIRED);
    expect((reply.payload as { output?: unknown }).output).toBeUndefined();
  });

  it("an agent holding no encryption seed passes a sealed payload through untouched", async () => {
    // Strictly additive: an embedder that opens sealed payloads in its own
    // handler (the reference adapter does) keeps working exactly as before.
    const conn = makeConn();
    const agentKp = nkeys.createUser();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      agentKp,
      nkeys.createUser(),
      { fenceInbound: false },
    );
    openAgents.push(agent);
    const seen: unknown[] = [];
    agent.onRequest("work", (input) => {
      seen.push(input);
      return { ok: true };
    });
    await agent.register({ name: "plain", offerings: [plainOffering] });
    const sealed = sealPayloadTo({ hi: 1 }, KEY.publicKey, undefined);
    await deliver(agent, conn, agentKp.getPublicKey(), sealed);
    expect(seen).toEqual([sealed]);
  });

  it("a sealed request naming no reply_key is answered in the clear (EXT-7 §3)", async () => {
    const { conn, agent, agentKp, enc, seen } = await vendorAgent();
    const sealed = sealPayloadTo({ records: [9] }, enc.publicKey, undefined);
    const reply = await deliver(agent, conn, agentKp.getPublicKey(), sealed);
    expect(seen).toEqual([{ records: [9] }]);
    expect((reply.payload as { output?: unknown }).output).toEqual({ filed: true });
  });
});

// ── a sender the registry will not describe ─────────────────────────────────
//
// The registry serves a `private` agent's manifest to its owner only and tells
// everyone else "not found" (services registry handlers/get.ts), and an agent
// that registers for the first time without saying is private. On 2026-10-11 a
// new adapter user's sealed message to an established agent was held at the
// door and then answered SEALING_REQUIRED, because the responder could not
// resolve the sender's key; the sender was told its message failed. The host's
// fallback (setEncryptionKeyFallback) is how the responder confirms the key.

describe("§8.9 the receiver — a sender the registry hides (private)", () => {
  async function hiddenSender(fallback?: (id: string) => Promise<string | null | undefined>) {
    const v = await vendorLikeAgent();
    const senderKp = nkeys.createUser();
    const senderEnc = createEncryptionIdentity();
    (v.conn as unknown as { request: ReturnType<typeof vi.fn> }).request.mockImplementation(
      fakeRegistry({}, { hidden: [senderKp.getPublicKey()] }),
    );
    if (fallback) v.agent.setEncryptionKeyFallback(fallback);
    return { ...v, senderKp, senderEnc };
  }

  /** An agent that reads plaintext and answers; holds an encryption seed. */
  async function vendorLikeAgent() {
    const conn = makeConn();
    const agentKp = nkeys.createUser();
    const enc = createEncryptionIdentity();
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      agentKp,
      nkeys.createUser(),
      { encryptionSeed: enc.seed, fenceInbound: false },
    );
    openAgents.push(agent);
    const seen: unknown[] = [];
    agent.onRequest("work", (input) => {
      seen.push(input);
      return { queued: true };
    });
    await agent.register({ name: "door", offerings: [plainOffering] });
    return { conn, agent, agentKp, enc, seen };
  }

  it("without a fallback the sealed ask is refused after the handler ran (the reported failure)", async () => {
    const { conn, agent, agentKp, enc, seen, senderKp, senderEnc } = await hiddenSender();
    const sealed = sealPayloadTo({ text: "hello" }, enc.publicKey, senderEnc.publicKey);
    const reply = await deliver(agent, conn, agentKp.getPublicKey(), sealed, senderKp);
    expect(seen).toEqual([{ text: "hello" }]);
    expect(reply.error?.code).toBe(ErrorCode.SEALING_REQUIRED);
  });

  it("the host's fallback confirms the claimed key and the answer comes back sealed to it", async () => {
    const asked: string[] = [];
    let senderKey = "";
    const { conn, agent, agentKp, enc, senderKp, senderEnc } = await hiddenSender(async (id) => {
      asked.push(id);
      return senderKey;
    });
    senderKey = senderEnc.publicKey;
    const sealed = sealPayloadTo({ text: "hello" }, enc.publicKey, senderEnc.publicKey);
    const reply = await deliver(agent, conn, agentKp.getPublicKey(), sealed, senderKp);
    expect(reply.error).toBeUndefined();
    expect(asked).toEqual([senderKp.getPublicKey()]);
    const output = (reply.payload as { output?: unknown }).output;
    expect(isSealedPayload(output)).toBe(true);
    expect(openSealedPayload(output as never, senderEnc.seed)?.payload).toEqual({ queued: true });
  });

  it("a fallback naming a different key is refused, never sealed to either", async () => {
    const other = createEncryptionIdentity();
    const { conn, agent, agentKp, enc, senderKp, senderEnc } = await hiddenSender(async () => other.publicKey);
    const sealed = sealPayloadTo({ text: "hello" }, enc.publicKey, senderEnc.publicKey);
    const reply = await deliver(agent, conn, agentKp.getPublicKey(), sealed, senderKp);
    expect(reply.error?.code).toBe(ErrorCode.SEALING_REQUIRED);
    expect((reply.payload as { output?: unknown }).output).toBeUndefined();
  });

  it("a fallback that throws or knows nothing is a refusal, not a crash", async () => {
    for (const fb of [async () => { throw new Error("registrar down"); }, async () => null]) {
      const { conn, agent, agentKp, enc, senderKp, senderEnc } = await hiddenSender(fb);
      const sealed = sealPayloadTo({ text: "hello" }, enc.publicKey, senderEnc.publicKey);
      const reply = await deliver(agent, conn, agentKp.getPublicKey(), sealed, senderKp);
      expect(reply.error?.code).toBe(ErrorCode.SEALING_REQUIRED);
    }
  });

  it("a key the registry vouches for wins: the fallback is not asked", async () => {
    const { conn, agent, agentKp, enc } = await vendorLikeAgent();
    const senderKp = nkeys.createUser();
    const senderEnc = createEncryptionIdentity();
    (conn as unknown as { request: ReturnType<typeof vi.fn> }).request.mockImplementation(
      fakeRegistry({ [senderKp.getPublicKey()]: recipientManifest({ kp: senderKp, encryptionKey: senderEnc.publicKey }) }),
    );
    const fallback = vi.fn(async () => createEncryptionIdentity().publicKey);
    agent.setEncryptionKeyFallback(fallback);
    const sealed = sealPayloadTo({ text: "hello" }, enc.publicKey, senderEnc.publicKey);
    const reply = await deliver(agent, conn, agentKp.getPublicKey(), sealed, senderKp);
    expect(reply.error).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("a cached key the sender has since moved on from is asked about again", async () => {
    const { conn, agent, agentKp, enc } = await vendorLikeAgent();
    const senderKp = nkeys.createUser();
    const oldEnc = createEncryptionIdentity();
    const newEnc = createEncryptionIdentity();
    const req = (conn as unknown as { request: ReturnType<typeof vi.fn> }).request;
    req.mockImplementation(fakeRegistry({ [senderKp.getPublicKey()]: recipientManifest({ kp: senderKp, encryptionKey: oldEnc.publicKey }) }));
    await agent.getManifest(senderKp.getPublicKey()); // cached with the old key
    req.mockImplementation(fakeRegistry({ [senderKp.getPublicKey()]: recipientManifest({ kp: senderKp, encryptionKey: newEnc.publicKey }) }));
    const sealed = sealPayloadTo({ text: "hello" }, enc.publicKey, newEnc.publicKey);
    const reply = await deliver(agent, conn, agentKp.getPublicKey(), sealed, senderKp);
    expect(reply.error).toBeUndefined();
    expect(openSealedPayload((reply.payload as { output?: unknown }).output as never, newEnc.seed)?.payload).toEqual({ queued: true });
  });
});

/** A registry stub serving the given manifests by id, for the reply-key
 *  resolution the responder does. `hidden` ids answer the way the registry
 *  answers a private agent to anyone but its owner: AGENT_UNAVAILABLE. */
function fakeRegistry(byId: Record<string, Manifest>, opts: { hidden?: string[] } = {}) {
  const registryKp = nkeys.createUser();
  return async (subject: string, data: Uint8Array) => {
    const req = decodeUnverified(data);
    const asked = subject.startsWith("mesh.registry.get.") ? subject.slice("mesh.registry.get.".length) : null;
    const hidden = asked !== null && (opts.hidden ?? []).includes(asked);
    const payload = asked !== null ? (byId[asked] ?? null) : { status: "registered" };
    return {
      data: encode(
        signEnvelope(
          createEnvelope({
            type: "respond",
            from: registryKp.getPublicKey(),
            to: req.from,
            in_reply_to: req.id,
            ...(hidden
              ? { error: { code: ErrorCode.AGENT_UNAVAILABLE, message: `Agent ${asked} not found`, retryable: false } }
              : { payload }),
          }),
          registryKp,
        ),
      ),
    };
  };
}
