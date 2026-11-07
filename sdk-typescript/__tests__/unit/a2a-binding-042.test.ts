/**
 * A2A binding 0.4.2-draft: a default offering (§12.1) and whom a trial is
 * for (§12.8). The pure readings are checked against
 * conformance/a2a-binding.json in a2a-binding-conformance.test.ts; here the
 * node routes by the default on the legacy path and through `a2a.serve`,
 * shows it on the card, and counts a trial against a requester only a
 * trusted host may name.
 */
import { describe, it, expect, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { makeBus, type Bus } from "./a2a-bus.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import type { AgentMesh } from "../../src/mesh.js";
import { A2AError } from "../../src/a2a/errors.js";
import { a2aCardFromManifest, defaultOfferingOf } from "../../src/a2a/card.js";
import { EXT_OFFERING, cardDefaultOffering, trialVouchOf, withOffering, withTrial, type A2ATrialRequester } from "../../src/a2a/extensions.js";
import { signAllowance } from "../../src/allowance.js";
import type { Manifest } from "../../src/types/manifest.js";
import type { Message } from "../../src/a2a/types.js";

let bus: Bus;
afterEach(async () => {
  await bus?.close();
});

const msg = (): Message => ({ messageId: `m-${Math.random().toString(36).slice(2)}`, role: "ROLE_USER", parts: [{ text: "hello" }] });
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof MeshError || e instanceof A2AError ? e.code : String(e)));

/** A server declaring `chat` and `help`, with `default_offering` set or not. */
function frontDesk(path: "legacy" | "serve", defaultOffering?: string) {
  bus = makeBus();
  const client = bus.agent();
  const server = bus.agent();
  (server as unknown as { manifest: Partial<Manifest> }).manifest = {
    id: server.id,
    name: "front desk",
    offerings: [{ id: "chat" }, { id: "help" }] as never,
    ...(defaultOffering ? { default_offering: defaultOffering } : {}),
  };
  const ran: string[] = [];
  if (path === "serve") {
    server.a2a.serve((_m, ctx) => {
      ran.push(ctx.offering ?? "");
      return { messageId: "r", role: "ROLE_AGENT", parts: [{ text: "hi" }] };
    });
  } else {
    server.onRequest("chat", () => (ran.push("chat"), "hi"));
    server.onRequest("help", () => (ran.push("help"), "hi"));
    (server as unknown as { listenInbox(): void }).listenInbox();
  }
  return { client, server, ran };
}

describe("a default offering (§12.1)", () => {
  for (const path of ["legacy", "serve"] as const) {
    it(`${path}: a Message naming none goes to the default; a named one wins; an undeclared one is refused`, async () => {
      const { client, server, ran } = frontDesk(path, "chat");
      expect(await code(client.a2a.sendMessage(server.id, msg(), { timeoutMs: 2000 }))).toBe("ok");
      expect(await code(client.a2a.sendMessage(server.id, withOffering(msg(), "help"), { timeoutMs: 2000 }))).toBe("ok");
      expect(await code(client.a2a.sendMessage(server.id, withOffering(msg(), "launch"), { timeoutMs: 2000 }))).toBe("InvalidParamsError");
      expect(ran).toEqual(["chat", "help"]);
    });

    it(`${path} (control): with several offerings and no default, a Message naming none is refused`, async () => {
      const { client, server, ran } = frontDesk(path);
      expect(await code(client.a2a.sendMessage(server.id, msg(), { timeoutMs: 2000 }))).toBe("InvalidParamsError");
      expect(ran).toEqual([]);
    });
  }

  it("the card names the default in the offering extension's params, only when it is declared", () => {
    const m = { id: "U1", name: "desk", version: "1", offerings: [{ id: "chat", name: "Chat" }, { id: "help", name: "Help" }], default_offering: "chat" } as unknown as Manifest;
    const card = a2aCardFromManifest(m, { meshHome: "https://mesh.example" });
    expect(card.capabilities.extensions?.find((e) => e.uri === EXT_OFFERING)?.params).toEqual({ default: "chat" });
    expect(cardDefaultOffering(card)).toBe("chat");
    expect(defaultOfferingOf({ ...m, default_offering: "launch" })).toBeUndefined();
    expect(cardDefaultOffering(a2aCardFromManifest({ ...m, default_offering: undefined }, { meshHome: "https://mesh.example" }))).toBeUndefined();
  });
});

describe("whom a trial is for (§12.8)", () => {
  /** A server offering a trial of `work` once per requester, ever. */
  function trialNode(trusted: boolean) {
    bus = makeBus();
    const host = bus.agent();
    const server = bus.agent();
    (server as unknown as { manifest: Partial<Manifest> }).manifest = { id: server.id, name: "trial", offerings: [{ id: "work" }] as never };
    const seen: Array<{ id: string; kind: string; signed_in: boolean } | undefined> = [];
    server.onRequest("work", (_i, ctx) => {
      seen.push(ctx.trial?.requester as never);
      return "done";
    });
    (server as unknown as { listenInbox(): void }).listenInbox();
    server.setAllowance(signAllowance({
      v: 1, agent: server.id,
      cost_model: { per_1k_tokens_micro: 1000, currency: "USD" },
      ceilings: [{ scope: "day", amount_micro: 10_000_000 }, { scope: "trial", amount_micro: 5_000_000 }],
      on_exhausted: "refuse",
      updated_at: new Date().toISOString(),
    } as never, nkeys.createUser()), { estimateTokens: () => 1000 });
    server.setTrials({
      trials: { work: { who: "anyone", limits: { per_requester_ever: 1 } } },
      describeSender: () => ({ signed_in: true, verified: true }),
      ...(trusted ? { trustedHosts: [host.id] } : {}),
    });
    const trial = (requester?: A2ATrialRequester) =>
      code(host.a2a.sendMessage(server.id, withTrial(withOffering(msg(), "work"), requester), { timeoutMs: 2000 }));
    return { host, server, seen, trial };
  }

  it("from a trusted host: each requester is counted on its own, and a visitor is never signed in", async () => {
    const { seen, trial } = trialNode(true);
    expect(await trial({ id: "visitor-1", kind: "visitor" })).toBe("ok");
    expect(await trial({ id: "visitor-2", kind: "visitor" })).toBe("ok");
    expect(await trial({ id: "visitor-1", kind: "visitor" })).toBe(ErrorCode.TRIAL_REFUSED);
    expect(await trial({ id: "acct-19", kind: "account", signedIn: true, verified: false })).toBe("ok");
    expect(seen).toEqual([
      { id: "visitor-1", kind: "visitor", signed_in: false, verified: false },
      { id: "visitor-2", kind: "visitor", signed_in: false, verified: false },
      { id: "acct-19", kind: "account", signed_in: true, verified: false },
    ]);
  });

  it("from anyone else the requester is ignored, and the sending agent is counted", async () => {
    const { host, seen, trial } = trialNode(false);
    expect(await trial({ id: "visitor-1", kind: "visitor" })).toBe("ok");
    expect(await trial({ id: "visitor-2", kind: "visitor" })).toBe(ErrorCode.TRIAL_REFUSED);
    expect(seen).toEqual([{ id: host.id, kind: "agent", signed_in: true, verified: true }]);
  });

  it("a malformed requester is no vouch: a visitor claiming to be signed in, an unknown kind", () => {
    const at = (r: unknown) => trialVouchOf({ ...msg(), metadata: { "https://agentmessaging.ai/extensions/trial/v1": { trial: true, requester: r } } });
    expect(at({ id: "v", kind: "visitor", signedIn: true })).toBeUndefined();
    expect(at({ id: "x", kind: "robot" })).toBeUndefined();
    expect(at({ id: "a", kind: "account", signedIn: true })).toEqual({ id: "a", kind: "account", signed_in: true, verified: false });
  });
});
