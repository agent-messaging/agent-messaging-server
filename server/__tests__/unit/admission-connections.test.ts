/**
 * The mesh-side door (admission service) and connections: a guarded agent's
 * roster entry with grants and an end date is enforced before delivery, as a
 * projection of the rule the recipient's own client applies
 * (admission/grants.ts), and a knock carrying anything but enumerated grant
 * names is refused in words.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEnvelope, decode, nkeys, Subjects } from "../../src/sdk.js";
import { sealEnvelope } from "../../src/shared/handler.js";

const senderKp = nkeys.createUser();
const agentKp = nkeys.createUser();
const SENDER = senderKp.getPublicKey();
const AGENT = agentKp.getPublicKey();
const GUARDED = `mesh.agent.${AGENT}.inbox.guarded`;

type Priv = {
  decide(recipientId: string, from: string, payload?: unknown, isRequest?: boolean): Promise<"relay" | "drop">;
  onInbox(recipientId: string, guardedSubject: string, msg: unknown): Promise<void>;
  manifestInfo(id: string): Promise<{ registered: boolean; owner: string | null }>;
  relayGuarded(...a: unknown[]): Promise<void>;
};

let roster: Record<string, unknown> | null = null;
let priv: Priv;
let published: Array<{ subject: string; data: Uint8Array }> = [];

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../../src/admission/admission-service.js");
  published = [];
  const nc = {
    subscribe: vi.fn(() => ({ unsubscribe() {}, async *[Symbol.asyncIterator]() {} })),
    publish: vi.fn((subject: string, data: Uint8Array) => { published.push({ subject, data }); }),
    request: vi.fn(async () => { throw new Error("no registry here"); }),
    jetstreamManager: vi.fn(async () => ({ streams: { info: vi.fn() } })),
  };
  const kvFake = {
    get: async (k: string) => (k === AGENT && roster ? { string: () => JSON.stringify(roster) } : null),
    put: async () => 1, delete: async () => undefined, purge: async () => undefined,
  };
  const js = { views: { kv: vi.fn(async () => kvFake) } };
  const svc = await mod.AdmissionService.create(nc as never, js as never);
  priv = svc as unknown as Priv;
  priv.manifestInfo = async () => ({ registered: true, owner: null });
});
afterEach(() => vi.unstubAllEnvs());

const entry = (over: Record<string, unknown>) => {
  roster = { admission: "v1", defaults: { registered: "block", anonymous: "block" }, entries: [{ subject: SENDER, stance: "allow", ...over }] };
};
const chat = (input: Record<string, unknown>) => ({ offering: "chat", input });

describe("the mesh-side door and a connection's entry", () => {
  it("relays what the grants allow and drops what they do not", async () => {
    entry({ grants: ["scheduling"], connection: "c1" });
    expect(await priv.decide(AGENT, SENDER, chat({ text: "Tue?", purpose: "scheduling" }), true)).toBe("relay");
    expect(await priv.decide(AGENT, SENDER, chat({ text: "deck", files: [{ ref: "r" }] }), true)).toBe("drop");
    expect(await priv.decide(AGENT, SENDER, chat({ text: "hello" }), true)).toBe("drop");
    // A sealed input cannot be read here; the recipient's client decides.
    expect(await priv.decide(AGENT, SENDER, { offering: "chat", input: "c2VhbGVk" }, true)).toBe("relay");
    // An answer coming back is not a new ask: responds are not grant-checked.
    expect(await priv.decide(AGENT, SENDER, undefined, false)).toBe("relay");
  });

  it("passes an Errands order within the limit on to the recipient (whose OK it needs) and drops one over it", async () => {
    entry({ grants: ["messages", "errands"], spend_limit_cents: 1000 });
    expect(await priv.decide(AGENT, SENDER, chat({ order: { amount_cents: 900 } }), true)).toBe("relay");
    expect(await priv.decide(AGENT, SENDER, chat({ order: { amount_cents: 1001 } }), true)).toBe("drop");
  });

  it("an entry past its end is no entry: the sender meets the tier default", async () => {
    entry({ grants: ["messages"], expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await priv.decide(AGENT, SENDER, chat({ text: "hi" }), true)).toBe("drop");
    entry({ grants: ["messages"], expires_at: new Date(Date.now() + 60_000).toISOString() });
    expect(await priv.decide(AGENT, SENDER, chat({ text: "hi" }), true)).toBe("relay");
  });

  it("a plain allow from before connections still allows everything", async () => {
    entry({});
    expect(await priv.decide(AGENT, SENDER, chat({ text: "x", files: [{ ref: "r" }] }), true)).toBe("relay");
  });
});

describe("a knock at the mesh-side door", () => {
  const knock = (input: unknown) => {
    const env = createEnvelope({ type: "request", from: SENDER, to: AGENT, payload: { offering: "knock", input } });
    return sealEnvelope(env, senderKp);
  };

  it("refuses a knock that carries words, in words, to the sender's inbox", async () => {
    const relay = vi.fn(async () => {});
    priv.relayGuarded = relay;
    await priv.onInbox(AGENT, GUARDED, { data: knock({ text: "please let me in, I have an offer" }), respond: vi.fn() });
    expect(relay).not.toHaveBeenCalled();
    const back = published.filter((p) => p.subject === Subjects.agentInbox(SENDER)).map((p) => decode(p.data) as { payload?: { output?: Record<string, unknown> } });
    expect(back[0]?.payload?.output).toMatchObject({ refused: true, code: "KNOCK_CARRIES_NO_MESSAGE" });
  });

  it("passes a knock with enumerated grants through, whatever the tier", async () => {
    roster = { admission: "v1", defaults: { registered: "hold", anonymous: "block" }, entries: [] };
    const relay = vi.fn(async () => {});
    priv.relayGuarded = relay;
    await priv.onInbox(AGENT, GUARDED, { data: knock({ grants: ["scheduling"] }), respond: vi.fn() });
    expect(relay).toHaveBeenCalledTimes(1);
  });
});
