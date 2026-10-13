// cancel() and the inbound task.cancel path (SPEC.md §10.8): the canceled
// update carries the reason, the inbox notification is best-effort, the door
// rejects reasons outside the closed enum, and a cancel for a task whose
// handler delegated work auto-cancels the still-live delegates as
// upstream_cancelled — unless the handler opted out (HandlerOptions).
import { describe, it, expect, vi, afterEach } from "vitest";
import { nkeys } from "nats.ws";
import type { KeyPair } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import { Subjects } from "../../src/internal/subjects.js";
import { ErrorCode } from "../../src/types/errors.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import type { Envelope } from "../../src/types/envelope.js";
import type { RespondPayload, RequestPayload } from "../../src/types/primitives.js";

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

/** A fake connection whose request() dispatches by subject: the registry
 *  registers, a delegate answers in Task mode, and everything else acks.
 *  Publishes and requests are recorded for assertions. */
function makeConn(opts?: {
  delegateKp?: KeyPair;
  delegateReply?: { task_id: string; status: string };
}) {
  const subs = new Map<string, (msg: unknown) => void>();
  const registryKp = nkeys.createUser();
  const published: { subject: string; data: Uint8Array }[] = [];
  const requested: { subject: string; env: Envelope }[] = [];
  const delegateId = opts?.delegateKp?.getPublicKey();
  return {
    subs,
    published,
    requested,
    publish: vi.fn((subject: string, data: Uint8Array) => {
      published.push({ subject, data });
      // Loop back to a matching subscription, the way the broker would: since
      // the §6.4 cutover, responds travel by publish to the sender's inbox.
      subs.get(subject)?.({ subject, data, reply: undefined, respond: () => true });
    }),
    request: vi.fn(async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      requested.push({ subject, env: req });
      const isDelegate = !!delegateId && subject === Subjects.agentInbox(delegateId);
      const replyFrom = isDelegate ? opts!.delegateKp! : registryKp;
      const payload = isDelegate
        ? { status: opts?.delegateReply?.status ?? "working" }
        : { status: "registered" };
      const bytes = encode(
        signEnvelope(
          createEnvelope({
            type: "respond",
            from: replyFrom.getPublicKey(),
            to: req.from,
            in_reply_to: req.id,
            task_id: isDelegate ? opts?.delegateReply?.task_id : undefined,
            payload,
          }),
          replyFrom,
        ),
      );
      // §6.4 cutover: an AGENT answers to the requester's inbox, and the
      // requester ignores data on the reply subject. Service subjects (the
      // registry) still answer request-reply.
      if (isDelegate) {
        subs.get(Subjects.agentInbox(req.from))?.({
          subject: Subjects.agentInbox(req.from),
          data: bytes,
          reply: undefined,
          respond: () => true,
        });
      }
      return { data: bytes };
    }),
    subscribe: vi.fn((subject: string, cb: (msg: unknown) => void) => {
      subs.set(subject, cb);
      return { unsubscribe: () => subs.delete(subject), drain: async () => {} };
    }),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    raw: { publish: () => {}, subscribe: vi.fn(() => ({ unsubscribe: () => {} })) },
    get isClosed() {
      return false;
    },
  };
}

async function makeAgent(conn: ReturnType<typeof makeConn>) {
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
  );
  openAgents.push(agent);
  await agent.register({ name: "cancel-test" });
  return agent;
}

/** Inject a signed inbound request into the agent's inbox subscription.
 *  §6.4 cutover: replies land on the SENDER's inbox, so this listens there
 *  (via the fake's publish loopback) rather than on a reply subject. */
function inject(
  conn: ReturnType<typeof makeConn>,
  agent: AgentMesh,
  kp: KeyPair,
  payload: RequestPayload,
  taskId?: string,
): Uint8Array[] {
  const env = signEnvelope(
    createEnvelope({
      type: "request",
      from: kp.getPublicKey(),
      to: agent.id,
      task_id: taskId,
      payload,
    }),
    kp,
  );
  const replies: Uint8Array[] = [];
  conn.subs.set(Subjects.agentInbox(kp.getPublicKey()), (m) => {
    replies.push((m as { data: Uint8Array }).data);
  });
  conn.subs.get(Subjects.agentInbox(agent.id))!({
    subject: Subjects.agentInbox(agent.id),
    data: encode(env),
    reply: "_INBOX.cancel-test",
    respond: () => true,
  });
  return replies;
}

const canceledUpdates = (conn: ReturnType<typeof makeConn>, taskId: string) =>
  conn.published
    .filter((p) => p.subject === Subjects.taskUpdate(taskId))
    .map((p) => decode(p.data))
    .filter((e) => (e.payload as RespondPayload | undefined)?.status === "canceled");

describe("cancel() — the requester's side of §10.8", () => {
  it("publishes the canceled update with reason+note, transitions locally, notifies the inbox", async () => {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({ delegateKp, delegateReply: { task_id: "tsk1", status: "working" } });
    const agent = await makeAgent(conn);

    const res = await agent.request(delegateKp.getPublicKey(), "work", { q: 1 });
    expect(res.task_id).toBe("tsk1");

    agent.cancel("tsk1", "superseded", "newer request replaces it");

    const updates = canceledUpdates(conn, "tsk1");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({
      status: "canceled",
      reason: "superseded",
      note: "newer request replaces it",
    });
    expect(agent.getTask("tsk1")?.state).toBe("canceled");

    // The best-effort inbox notification (§10.8's composed request).
    await vi.waitFor(() => {
      const cancelReqs = conn.requested.filter(
        (r) =>
          r.subject === Subjects.agentInbox(delegateKp.getPublicKey()) &&
          (r.env.payload as RequestPayload | undefined)?.offering === "task.cancel",
      );
      expect(cancelReqs).toHaveLength(1);
      expect((cancelReqs[0].env.payload as RequestPayload).input).toEqual({
        task_id: "tsk1",
        reason: "superseded",
        note: "newer request replaces it",
      });
    });
  });

  it("omits an absent note from the update payload — absent, never null", async () => {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({ delegateKp, delegateReply: { task_id: "tsk2", status: "working" } });
    const agent = await makeAgent(conn);
    await agent.request(delegateKp.getPublicKey(), "work", {});

    agent.cancel("tsk2", "user_requested");
    const [update] = canceledUpdates(conn, "tsk2");
    expect("note" in (update.payload as Record<string, unknown>)).toBe(false);
  });

  it("cancels from input_required — the §7.7 pause's promised exit", async () => {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({
      delegateKp,
      delegateReply: { task_id: "tsk3", status: "input_required" },
    });
    const agent = await makeAgent(conn);
    await agent.request(delegateKp.getPublicKey(), "work", {});
    expect(agent.getTask("tsk3")?.state).toBe("input_required");

    agent.cancel("tsk3", "budget_exhausted", "not worth raising the ceiling");
    expect(agent.getTask("tsk3")?.state).toBe("canceled");
  });

  it("throws TASK_NOT_FOUND for an untracked task", async () => {
    const conn = makeConn();
    const agent = await makeAgent(conn);
    expect(() => agent.cancel("nope", "user_requested")).toThrowError(
      expect.objectContaining({ code: ErrorCode.TASK_NOT_FOUND }),
    );
  });

  it("throws TASK_NOT_CANCELABLE for a terminal task", async () => {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({ delegateKp, delegateReply: { task_id: "tsk4", status: "working" } });
    const agent = await makeAgent(conn);
    await agent.request(delegateKp.getPublicKey(), "work", {});
    agent.cancel("tsk4", "user_requested");
    expect(() => agent.cancel("tsk4", "user_requested")).toThrowError(
      expect.objectContaining({ code: ErrorCode.TASK_NOT_CANCELABLE }),
    );
  });

  it("rejects a reason outside the closed enum before anything is sent", async () => {
    const conn = makeConn();
    const agent = await makeAgent(conn);
    const publishesBefore = conn.published.length;
    expect(() => agent.cancel("tsk", "bored" as never)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_ENVELOPE }),
    );
    expect(conn.published.length).toBe(publishesBefore);
  });

  it("carries unmet_need on both legs when the reason takes one (§10.8)", async () => {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({ delegateKp, delegateReply: { task_id: "tsk5", status: "working" } });
    const agent = await makeAgent(conn);
    await agent.request(delegateKp.getPublicKey(), "work", {});

    agent.cancel("tsk5", "needs_not_furnished", undefined, {
      unmetNeed: "credential:Salesforce",
    });
    const [update] = canceledUpdates(conn, "tsk5");
    expect(update.payload).toMatchObject({
      status: "canceled",
      reason: "needs_not_furnished",
      unmet_need: "credential:Salesforce",
    });
    await vi.waitFor(() => {
      const reqs = conn.requested.filter(
        (r) => (r.env.payload as RequestPayload | undefined)?.offering === "task.cancel",
      );
      expect((reqs[0].env.payload as RequestPayload).input).toMatchObject({
        unmet_need: "credential:Salesforce",
      });
    });
  });

  it("refuses needs_not_furnished with nothing named, before anything is sent", async () => {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({ delegateKp, delegateReply: { task_id: "tsk6", status: "working" } });
    const agent = await makeAgent(conn);
    await agent.request(delegateKp.getPublicKey(), "work", {});
    const before = conn.published.length;
    expect(() => agent.cancel("tsk6", "needs_not_furnished")).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_ENVELOPE }),
    );
    expect(conn.published.length).toBe(before);
    expect(agent.getTask("tsk6")?.state).toBe("working");
  });
});

describe("failTask() — saying why the work ended badly (§10.8)", () => {
  const failedUpdates = (conn: ReturnType<typeof makeConn>, taskId: string) =>
    conn.published
      .filter((p) => p.subject === Subjects.taskUpdate(taskId))
      .map((p) => decode(p.data))
      .filter((e) => (e.payload as RespondPayload | undefined)?.status === "failed");

  it("publishes a bare failure — nobody has to invent an excuse", async () => {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({ delegateKp, delegateReply: { task_id: "tskf1", status: "working" } });
    const agent = await makeAgent(conn);
    await agent.request(delegateKp.getPublicKey(), "work", {});

    agent.failTask("tskf1");
    const [update] = failedUpdates(conn, "tskf1");
    expect(update.payload).toEqual({ status: "failed" });
    expect(agent.getTask("tskf1")?.state).toBe("failed");
  });

  it("carries the reason and the service that broke", async () => {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({ delegateKp, delegateReply: { task_id: "tskf2", status: "working" } });
    const agent = await makeAgent(conn);
    await agent.request(delegateKp.getPublicKey(), "work", {});

    agent.failTask("tskf2", "dependency_failed", "the search form moved", {
      dependency: "Colorado DMV",
    });
    const [update] = failedUpdates(conn, "tskf2");
    expect(update.payload).toEqual({
      status: "failed",
      reason: "dependency_failed",
      note: "the search form moved",
      dependency: "Colorado DMV",
    });
  });

  it("never puts an attribution on the wire — that is the platform's to compute", async () => {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({ delegateKp, delegateReply: { task_id: "tskf3", status: "working" } });
    const agent = await makeAgent(conn);
    await agent.request(delegateKp.getPublicKey(), "work", {});

    agent.failTask("tskf3", "needs_not_furnished", undefined, {
      unmetNeed: "credential:Salesforce",
    });
    const [update] = failedUpdates(conn, "tskf3");
    expect(update.payload).toEqual({
      status: "failed",
      reason: "needs_not_furnished",
      unmet_need: "credential:Salesforce",
    });
    expect("attribution" in (update.payload as Record<string, unknown>)).toBe(false);
  });

  it("refuses an unnamed claim before anything is sent", async () => {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({ delegateKp, delegateReply: { task_id: "tskf4", status: "working" } });
    const agent = await makeAgent(conn);
    await agent.request(delegateKp.getPublicKey(), "work", {});
    const before = conn.published.length;
    expect(() => agent.failTask("tskf4", "needs_not_furnished")).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_ENVELOPE }),
    );
    expect(conn.published.length).toBe(before);
    expect(agent.getTask("tskf4")?.state).toBe("working");
  });

  it("throws for an untracked task and for one already terminal", async () => {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({ delegateKp, delegateReply: { task_id: "tskf5", status: "working" } });
    const agent = await makeAgent(conn);
    expect(() => agent.failTask("nope")).toThrowError(
      expect.objectContaining({ code: ErrorCode.TASK_NOT_FOUND }),
    );
    await agent.request(delegateKp.getPublicKey(), "work", {});
    agent.failTask("tskf5");
    expect(() => agent.failTask("tskf5")).toThrowError(
      expect.objectContaining({ code: ErrorCode.TASK_INVALID_TRANSITION }),
    );
  });
});

describe("inbound task.cancel — the performer's side of §10.8", () => {
  it("acknowledges a valid cancel with status canceled, without any registered handler", async () => {
    const conn = makeConn();
    const agent = await makeAgent(conn);
    const senderKp = nkeys.createUser();

    const replies = inject(conn, agent, senderKp, {
      offering: "task.cancel",
      input: { task_id: "sometask", reason: "user_requested" },
    });
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    const reply = decode(replies[0]);
    expect((reply.payload as RespondPayload).status).toBe("canceled");
    expect(reply.task_id).toBe("sometask");
    expect(reply.error ?? null).toBeNull();
  });

  it("rejects an unknown reason as INVALID_ENVELOPE at the door", async () => {
    const conn = makeConn();
    const agent = await makeAgent(conn);
    const replies = inject(conn, agent, nkeys.createUser(), {
      offering: "task.cancel",
      input: { task_id: "sometask", reason: "bored" },
    });
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    const reply = decode(replies[0]);
    expect(reply.error).toMatchObject({ code: ErrorCode.INVALID_ENVELOPE, retryable: false });
  });

  it("rejects a missing reason as INVALID_ENVELOPE at the door", async () => {
    const conn = makeConn();
    const agent = await makeAgent(conn);
    const replies = inject(conn, agent, nkeys.createUser(), {
      offering: "task.cancel",
      input: { task_id: "sometask" },
    });
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    expect(decode(replies[0]).error).toMatchObject({ code: ErrorCode.INVALID_ENVELOPE });
  });
});

describe("propagation — a cancel reaches the still-live delegates (§10.8)", () => {
  async function delegatingAgent(handlerOpts?: { propagateCancel?: boolean }) {
    const delegateKp = nkeys.createUser();
    const conn = makeConn({ delegateKp, delegateReply: { task_id: "subtask1", status: "working" } });
    const agent = AgentMesh.withConnection(
      conn as unknown as ConnectionManager,
      nkeys.createUser(),
      nkeys.createUser(),
    );
    openAgents.push(agent);
    agent.onRequest(
      "parent",
      async () => {
        await agent.request(delegateKp.getPublicKey(), "sub-work", { part: 1 });
        return { delegated: true };
      },
      handlerOpts,
    );
    await agent.register({ name: "delegator" });
    return { agent, conn, delegateKp };
  }

  /** The first NON-accept reply (§6.4a: the accept precedes the handler and
   *  therefore precedes the delegate request this suite waits on). */
  function substantiveOf(replies: Uint8Array[]) {
    return replies
      .map((d) => decode(d))
      .find((e) => (e.payload as RespondPayload | undefined)?.status !== "accepted");
  }

  async function runParentThenCancel(
    agent: AgentMesh,
    conn: ReturnType<typeof makeConn>,
    cancelInput: Record<string, unknown>,
  ) {
    const requesterKp = nkeys.createUser();
    const parentReplies = inject(
      conn,
      agent,
      requesterKp,
      { offering: "parent", input: { go: true } },
      "parenttask1",
    );
    await vi.waitFor(() => expect(substantiveOf(parentReplies)).toBeDefined());
    expect(agent.getTask("subtask1")?.state).toBe("working");

    const cancelReplies = inject(conn, agent, requesterKp, {
      offering: "task.cancel",
      input: cancelInput,
    });
    await vi.waitFor(() => expect(cancelReplies.length).toBeGreaterThan(0));
    return decode(cancelReplies[0]);
  }

  it("forwards upstream_cancelled with the original reason in the note", async () => {
    const { agent, conn, delegateKp } = await delegatingAgent();
    const ack = await runParentThenCancel(agent, conn, {
      task_id: "parenttask1",
      reason: "deadline_exceeded",
      note: "overdue since 16:00Z",
    });
    expect((ack.payload as RespondPayload).status).toBe("canceled");

    // The delegate's task was canceled locally and on the wire...
    const updates = canceledUpdates(conn, "subtask1");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({
      status: "canceled",
      reason: "upstream_cancelled",
      note: "deadline_exceeded: overdue since 16:00Z",
    });
    expect(agent.getTask("subtask1")?.state).toBe("canceled");

    // ...and the delegate was told to stop, with the pinned forwarded shape.
    await vi.waitFor(() => {
      const forwarded = conn.requested.filter(
        (r) =>
          r.subject === Subjects.agentInbox(delegateKp.getPublicKey()) &&
          (r.env.payload as RequestPayload | undefined)?.offering === "task.cancel",
      );
      expect(forwarded).toHaveLength(1);
      expect((forwarded[0].env.payload as RequestPayload).input).toEqual({
        task_id: "subtask1",
        reason: "upstream_cancelled",
        note: "deadline_exceeded: overdue since 16:00Z",
      });
    });
  });

  it("a delegate already terminal is not re-canceled", async () => {
    const { agent, conn } = await delegatingAgent();
    const requesterKp = nkeys.createUser();
    const parentReplies = inject(
      conn,
      agent,
      requesterKp,
      { offering: "parent", input: {} },
      "parenttask1",
    );
    await vi.waitFor(() => expect(substantiveOf(parentReplies)).toBeDefined());

    // The sub-task completes before the cancel arrives.
    agent["tasks"].transition("subtask1", "completed");

    const cancelReplies = inject(conn, agent, requesterKp, {
      offering: "task.cancel",
      input: { task_id: "parenttask1", reason: "user_requested" },
    });
    await vi.waitFor(() => expect(cancelReplies.length).toBeGreaterThan(0));
    expect(canceledUpdates(conn, "subtask1")).toHaveLength(0);
  });

  it("propagateCancel: false opts the handler out — its delegates are left alone", async () => {
    const { agent, conn, delegateKp } = await delegatingAgent({ propagateCancel: false });
    const ack = await runParentThenCancel(agent, conn, {
      task_id: "parenttask1",
      reason: "user_requested",
    });
    // The cancel itself is still acknowledged...
    expect((ack.payload as RespondPayload).status).toBe("canceled");
    // ...but nothing was forwarded and the sub-task still runs.
    expect(canceledUpdates(conn, "subtask1")).toHaveLength(0);
    expect(agent.getTask("subtask1")?.state).toBe("working");
    const forwarded = conn.requested.filter(
      (r) =>
        r.subject === Subjects.agentInbox(delegateKp.getPublicKey()) &&
        (r.env.payload as RequestPayload | undefined)?.offering === "task.cancel",
    );
    expect(forwarded).toHaveLength(0);
  });
});
