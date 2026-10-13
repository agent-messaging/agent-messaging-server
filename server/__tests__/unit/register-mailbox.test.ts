// The registry answers a registration only once the agent's mailbox exists
// (§16.4; docs/rabbitmq-binding.md §6.1).
//
// On the RabbitMQ binding nothing keeps a message published on an agent's
// inbox subject except a queue bound to it. The registry used to start making
// the mailbox and answer at once, so an agent could be told it was registered
// while its mailbox did not exist yet. Its node looked for the mailbox, found
// none, and listened live; the mailbox appeared a moment later. A request sent
// in that moment, before the live subscription was bound, landed only in the
// mailbox, which nobody read until the node's next pass a minute later: the
// sender timed out (the `mesh (rabbitmq)` job's example 01, conformance c03).
//
// What these pin: the answer waits for the mailbox, and a mailbox that cannot
// be made in time never holds a registration up or fails it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRegister, MAILBOX_WAIT_MS } from "../../src/registry/handlers/register.js";
import { createAttestation, createEnvelope, nkeys } from "../../src/sdk.js";
import type { Manifest } from "../../src/sdk.js";
import { PresenceStore } from "../../src/registry/presence-store.js";
import { NodeProfileStore } from "../../src/registry/node-profile-store.js";

function kv() {
  const store = new Map<string, Uint8Array>();
  return {
    put: vi.fn(async (k: string, d: Uint8Array) => {
      store.set(k, d);
      return 1;
    }),
    get: vi.fn(async () => null),
  };
}

function registration(opts: { sandbox?: boolean } = {}) {
  const kp = nkeys.createUser();
  const id = kp.getPublicKey();
  const manifest = {
    id,
    name: "Mailbox Agent",
    description: "",
    version: "1.0.0",
    protocol_version: "0.2.0",
    endpoint: `mesh.agent.${id}.inbox`,
    node: { id, attestation: createAttestation(kp, id) },
    capabilities: [],
    offerings: [],
    ...(opts.sandbox ? { sandbox: true } : {}),
  } as unknown as Manifest;
  return { id, env: createEnvelope({ type: "register", from: id, payload: manifest }) };
}

/** An inbox buffer whose `ensure` finishes only when the test says so. */
function slowBuffer() {
  let finish!: () => void;
  const made = new Promise<void>((r) => (finish = r));
  const buffer = {
    ensure: vi.fn(() => made),
    remove: vi.fn(async () => undefined),
  };
  return { buffer, finish };
}

function register(env: ReturnType<typeof registration>["env"], buffer: unknown) {
  return handleRegister(
    env,
    kv() as never,
    { publish: vi.fn() } as never,
    "mesh.service.registry",
    new Map(),
    new PresenceStore(),
    new NodeProfileStore(),
    buffer as never,
  );
}

/** Whether a promise has settled, after the microtasks queued so far ran. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  return done;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a registration is answered once the agent's mailbox exists", () => {
  it("does not answer while the mailbox is still being made", async () => {
    const { id, env } = registration();
    const { buffer, finish } = slowBuffer();
    const answer = register(env, buffer);

    expect(await settled(answer)).toBe(false);
    expect(buffer.ensure).toHaveBeenCalledWith(id);

    finish();
    const resp = await answer;
    expect(resp.error).toBeUndefined();
    expect((resp.payload as { status?: string }).status).toBe("registered");
  });

  it("answers anyway when the mailbox takes longer than the bound, so registration never hangs on the broker", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { env } = registration();
    const { buffer } = slowBuffer(); // never finishes
    const answer = register(env, buffer);

    expect(await settled(answer)).toBe(false);
    await vi.advanceTimersByTimeAsync(MAILBOX_WAIT_MS);
    const resp = await answer;
    expect(resp.error).toBeUndefined();
    expect((resp.payload as { status?: string }).status).toBe("registered");
  });

  it("does not wait on a sandbox agent, which has no mailbox", async () => {
    const { id, env } = registration({ sandbox: true });
    const { buffer } = slowBuffer();
    buffer.remove = vi.fn(() => new Promise<undefined>(() => undefined)); // never finishes either
    const resp = await register(env, buffer);
    expect(resp.error).toBeUndefined();
    expect(buffer.ensure).not.toHaveBeenCalled();
    expect(buffer.remove).toHaveBeenCalledWith(id);
  });
});
