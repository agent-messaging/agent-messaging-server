/**
 * A2A binding 0.2.0-draft additions: the four budget outcomes (§12.2), cancel
 * reasons (§12.6), artifact references on any carrier URI (§12.5), and sealed
 * frames with the state in clear (§8a).
 */
import { describe, it, expect, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import { makeBus, tick, type Bus } from "./a2a-bus.js";
import { signManifest } from "../../src/internal/identity.js";
import { createEncryptionIdentity, isSealedPayload } from "../../src/internal/sealed.js";
import { Subjects } from "../../src/internal/subjects.js";
import type { Manifest } from "../../src/types/manifest.js";
import type { AgentMesh } from "../../src/mesh.js";
import {
  A2AError,
  A2A_STATE_META,
  EXT_BUDGET,
  EXT_CANCEL,
  artifactRefOf,
  artifactRefPart,
  budgetOutcomeOf,
  cancelReasonOf,
  isAcceptSignal,
  isCeilingReached,
  stateOfFrame,
  withBudget,
  type Message,
} from "../../src/a2a/index.js";

let bus: Bus;
afterEach(async () => {
  await bus.close();
});

const msg = (text: string, extra: Partial<Message> = {}): Message => ({
  messageId: `m-${Math.random().toString(36).slice(2)}`,
  role: "ROLE_USER",
  parts: [{ text }],
  ...extra,
});

async function rejects(p: Promise<unknown>): Promise<A2AError> {
  try {
    await p;
  } catch (err) {
    return err as A2AError;
  }
  throw new Error("expected a rejection");
}

describe("§12.2 the four budget outcomes", () => {
  it("insufficient and deadline_unmeetable reject the Task at admission", async () => {
    bus = makeBus();
    const client = bus.agent();
    const server = bus.agent();
    server.a2a.serve((m, ctx) => {
      const t = ctx.startTask();
      if (m.parts[0].text === "cheap") t.insufficient({ amountMicro: 9_000_000, currency: "USD" });
      else t.deadlineUnmeetable("2026-12-01T00:00:00Z");
      return t;
    });
    const a = await client.a2a.sendMessage(server.id, msg("cheap"));
    expect(a.task?.status.state).toBe("TASK_STATE_REJECTED");
    expect(budgetOutcomeOf(a.task)).toEqual({ outcome: "insufficient", estimate: { amountMicro: 9_000_000, currency: "USD" } });
    const b = await client.a2a.sendMessage(server.id, msg("soon"));
    expect(b.task?.status.state).toBe("TASK_STATE_REJECTED");
    expect(b.task?.metadata?.[EXT_BUDGET]).toEqual({ outcome: "deadline_unmeetable", earliestCompletion: "2026-12-01T00:00:00Z" });
    expect(b.task?.status.message?.parts[0].text).toBeTruthy();
  });

  it("ceiling_reached pauses input-required; only a higher revision resumes it", async () => {
    bus = makeBus();
    const client = bus.agent();
    const server = bus.agent();
    server.a2a.serve((_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      if (!ctx.existingTask) {
        t.ceilingReached({ amountMicro: 4_000_000, currency: "USD" }, { amountMicro: 2_000_000, currency: "USD" });
      } else {
        t.complete("Finished on the raised budget.");
      }
      return t;
    });
    const start = withBudget(msg("go"), { revision: 0, cost_ceiling: { amount_micro: 4_000_000, currency: "USD" } });
    const first = await client.a2a.sendMessage(server.id, start);
    expect(first.task?.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(isCeilingReached(first.task)).toBe(true);
    expect(budgetOutcomeOf(first.task)).toMatchObject({
      outcome: "ceiling_reached",
      spent: { amountMicro: 4_000_000 },
      estimateToFinish: { amountMicro: 2_000_000 },
    });

    const taskId = first.task!.id;
    const same = await rejects(
      client.a2a.sendMessage(server.id, withBudget(msg("more?", { taskId }), { revision: 0, cost_ceiling: { amount_micro: 9_000_000, currency: "USD" } })),
    );
    expect(same.code).toBe("InvalidParamsError");
    const none = await rejects(client.a2a.sendMessage(server.id, msg("please", { taskId })));
    expect(none.code).toBe("InvalidParamsError");

    const raised = await client.a2a.sendMessage(
      server.id,
      withBudget(msg("raised", { taskId }), { revision: 1, cost_ceiling: { amount_micro: 7_000_000, currency: "USD" } }),
    );
    expect(raised.task?.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("a paused Task ends on a cancel with the reason budget_exhausted, recorded on the Task", async () => {
    bus = makeBus();
    const client = bus.agent();
    const server = bus.agent();
    server.a2a.serve((_m, ctx) => {
      const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
      t.ceilingReached({ amountMicro: 1, currency: "USD" }, { amountMicro: 1, currency: "USD" });
      return t;
    });
    const first = await client.a2a.sendMessage(server.id, withBudget(msg("go"), { revision: 0, cost_ceiling: { amount_micro: 1, currency: "USD" } }));
    const canceled = await client.a2a.cancelTask(server.id, first.task!.id, { cancel: { reason: "budget_exhausted" } });
    expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
    expect(cancelReasonOf(canceled)).toEqual({ reason: "budget_exhausted" });
  });
});

describe("§12.6 cancel reasons", () => {
  function setup() {
    bus = makeBus();
    const client = bus.agent();
    const server = bus.agent();
    let seen: unknown;
    server.a2a.serve((_m, ctx) => ctx.startTask({ state: "TASK_STATE_WORKING" }), {
      onCancel: (_t, _c, cancel) => void (seen = cancel),
    });
    return { client, server, seen: () => seen };
  }

  it("the client sends a reason (user_requested by default) and the canceled Task keeps it", async () => {
    const { client, server, seen } = setup();
    const t = await client.a2a.sendMessage(server.id, msg("go"));
    const c = await client.a2a.cancelTask(server.id, t.task!.id);
    expect(c.metadata?.[EXT_CANCEL]).toEqual({ reason: "user_requested" });
    expect(seen()).toEqual({ reason: "user_requested" });
    const req = bus.log.find((l) => (l.env.payload as { a2a?: { method?: string } })?.a2a?.method === "CancelTask")!.env;
    expect((req.meta as { a2a: Record<string, string> }).a2a["A2A-Extensions"]).toContain(EXT_CANCEL);
  });

  it("a reason with its qualifying field is carried as given", async () => {
    const { client, server } = setup();
    const t = await client.a2a.sendMessage(server.id, msg("go"));
    const c = await client.a2a.cancelTask(server.id, t.task!.id, {
      cancel: { reason: "needs_not_furnished", unmetNeed: "credential:salesforce", note: "no login" },
    });
    expect(cancelReasonOf(c)).toEqual({ reason: "needs_not_furnished", unmetNeed: "credential:salesforce", note: "no login" });
  });

  it("a client that does not declare the extension may send none: recorded as user_requested", async () => {
    const { client, server } = setup();
    const t = await client.a2a.sendMessage(server.id, msg("go"));
    const c = await client.a2a.call(server.id, "CancelTask", { id: t.task!.id });
    expect(cancelReasonOf(c)).toEqual({ reason: "user_requested" });
  });

  it("a declaring client without a reason, a reason off the list, or a missing qualifier is refused", async () => {
    const { client, server } = setup();
    const t = await client.a2a.sendMessage(server.id, msg("go"));
    const id = t.task!.id;
    expect((await rejects(client.a2a.call(server.id, "CancelTask", { id }, { extensions: [EXT_CANCEL] }))).code).toBe("InvalidParamsError");
    expect((await rejects(client.a2a.call(server.id, "CancelTask", { id, metadata: { [EXT_CANCEL]: { reason: "bored" } } }))).code).toBe(
      "InvalidParamsError",
    );
    expect(
      (await rejects(client.a2a.call(server.id, "CancelTask", { id, metadata: { [EXT_CANCEL]: { reason: "needs_not_furnished" } } }))).code,
    ).toBe("InvalidParamsError");
    // None of them canceled it.
    expect((await client.a2a.getTask(server.id, id)).status.state).toBe("TASK_STATE_WORKING");
  });
});

describe("§12.5 artifact references on any carrier", () => {
  it("reads a cid:, https: or mesh reference with its size and digest", () => {
    for (const ref of ["cid:part1.abc@example.com", "https://files.example.com/r.pdf", "mesh:artifacts:abc"]) {
      const p = artifactRefPart({ ref, size: 10, digest: `sha256:${"b".repeat(64)}`, mediaType: "application/pdf" });
      expect(artifactRefOf(p)).toMatchObject({ ref, size: 10, mediaType: "application/pdf" });
    }
  });
});

describe("§8a sealed frames", () => {
  function claimed(agent: AgentMesh, kp: ReturnType<typeof nkeys.createUser>, encryptionKey: string): Manifest {
    const m: Manifest = {
      id: agent.id,
      name: "a",
      description: "",
      version: "1.0.0",
      protocol_version: "0.3.0",
      endpoint: Subjects.agentInbox(agent.id),
      endpoints: { inbox: Subjects.agentInbox(agent.id) },
      capabilities: [],
      offerings: [],
      node: { id: agent.id, attestation: { node: agent.id, agent: agent.id, issued_at: "", expires_at: "", sig: "" } },
      encryption_key: encryptionKey,
    };
    signManifest(m, kp);
    return m;
  }

  it("the A2A object travels sealed both ways; the state may show in clear, and the payload wins", async () => {
    bus = makeBus();
    const ck = nkeys.createUser();
    const sk = nkeys.createUser();
    const ce = createEncryptionIdentity();
    const se = createEncryptionIdentity();
    const client = bus.agent(ck, { encryptionSeed: ce.seed });
    const server = bus.agent(sk, { encryptionSeed: se.seed });
    (client as unknown as { manifestCache: Map<string, Manifest> }).manifestCache.set(server.id, claimed(server, sk, se.publicKey));
    (server as unknown as { manifestCache: Map<string, Manifest> }).manifestCache.set(client.id, claimed(client, ck, ce.publicKey));
    let seenText: string | undefined;
    server.a2a.serve(
      (m, ctx) => {
        seenText = m.parts[0].text;
        const t = ctx.startTask({ state: "TASK_STATE_WORKING" });
        t.complete("sealed answer");
        return t;
      },
      { stateInClear: true },
    );
    const res = await client.a2a.sendMessage(server.id, msg("secret"), { seal: true });
    expect(seenText).toBe("secret");
    expect(res.task?.status.state).toBe("TASK_STATE_COMPLETED");

    const req = bus.log.find((l) => l.env.type === "request" && l.env.to === server.id)!.env;
    expect(isSealedPayload(req.payload)).toBe(true);
    // The accept signal is a channel frame (§4), in clear; the answer is sealed.
    const resp = bus.log.find((l) => l.env.type === "respond" && l.env.in_reply_to === req.id && l.subject === Subjects.agentInbox(client.id) && !isAcceptSignal(l.env))!.env;
    expect(isSealedPayload(resp.payload)).toBe(true);
    expect((resp.meta as Record<string, string>)[A2A_STATE_META]).toBe("TASK_STATE_COMPLETED");
    // A carrier that cannot open it reads the clear state as a hint only.
    expect(stateOfFrame(resp)).toEqual({ state: "TASK_STATE_COMPLETED", fromMeta: true });
    // A receiver that opened it reads the payload, whatever meta says.
    const lying = { ...resp, meta: { [A2A_STATE_META]: "TASK_STATE_FAILED" }, payload: { a2a: { result: { task: res.task } } } };
    expect(stateOfFrame(lying)).toEqual({ state: "TASK_STATE_COMPLETED", fromMeta: false });
    await tick(10);
  });
});
