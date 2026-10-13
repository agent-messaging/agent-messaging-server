import { describe, it, expect, vi, beforeEach } from "vitest";
import { OfferingRouter } from "../../src/internal/offering-router.js";
import {
  createStreamWriter,
  createChunkIterable,
  type StreamChunk,
} from "../../src/internal/stream.js";
import { TaskTracker } from "../../src/internal/task-tracker.js";
import { makeSigned, testPub } from "../helpers.js";
import { encode } from "../../src/internal/codec.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";
import { newTraceContext } from "../../src/internal/trace.js";
import { uuid7 } from "../../src/internal/uuid.js";
import type { StreamChunkPayload } from "../../src/types/primitives.js";

// ── Mock ConnectionManager ───────────────────────────────────────

function createMockConn() {
  const published: { subject: string; data: Uint8Array }[] = [];
  return {
    publish: vi.fn((subject: string, data: Uint8Array) => {
      published.push({ subject, data });
    }),
    published,
  };
}

// ── Mock NATS Subscription ───────────────────────────────────────

function createMockSubscription() {
  const queue: { data: Uint8Array }[] = [];
  let resolve: ((value: IteratorResult<{ data: Uint8Array }>) => void) | null =
    null;
  let done = false;
  const unsubscribe = vi.fn(() => {
    done = true;
    if (resolve) resolve({ done: true, value: undefined });
  });

  const sub = {
    unsubscribe,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<{ data: Uint8Array }>> {
          if (done) return Promise.resolve({ done: true, value: undefined });
          const queued = queue.shift();
          if (queued)
            return Promise.resolve({ done: false, value: queued });
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
    // Test helper: push a message into the subscription
    push(data: Uint8Array) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ done: false, value: { data } });
      } else {
        queue.push({ data });
      }
    },
    // Test helper: signal completion
    complete() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ done: true, value: undefined });
      }
    },
  };

  return sub;
}

function makeChunkEnvelope(
  payload: StreamChunkPayload,
  opts: { taskId?: string; from?: string; error?: unknown } = {},
) {
  return makeSigned({
    type: "respond",
    from: opts.from ?? "responder-1",
    to: "requester-1",
    task_id: opts.taskId ?? "task-1",
    trace: newTraceContext(),
    payload,
    error: opts.error as any,
  });
}

// ─── StreamWriter Tests ──────────────────────────────────────────

describe("createStreamWriter", () => {
  let conn: ReturnType<typeof createMockConn>;
  const params = {
    agentId: "responder-1",
    requesterId: "requester-1",
    requestId: "req-1",
    taskId: "task-1",
    trace: newTraceContext(),
    // §11.6: the writer signs the final chunk (and the task update). Tests use
    // a passthrough marker so signed envelopes are identifiable.
    sign: (e: any) => ({ ...e, sig: "signed-by-test" }),
  };

  beforeEach(() => {
    conn = createMockConn();
  });

  it("starts with closed = false", () => {
    const writer = createStreamWriter(conn as any, params);
    expect(writer.closed).toBe(false);
  });

  it("exposes taskId", () => {
    const writer = createStreamWriter(conn as any, params);
    expect(writer.taskId).toBe("task-1");
  });

  it("write() publishes chunk to stream subject", () => {
    const writer = createStreamWriter(conn as any, params);
    writer.write("hello");

    expect(conn.publish).toHaveBeenCalledTimes(1);
    expect(conn.published[0].subject).toBe("mesh.task.task-1.stream");

    const env = JSON.parse(new TextDecoder().decode(conn.published[0].data));
    expect(env.payload.chunk_index).toBe(0);
    expect(env.payload.final).toBe(false);
    expect(env.payload.data).toBe("hello");
    expect(env.payload.status).toBe("working");
    expect(env.sig).toBeUndefined(); // §11.6: intermediate chunks unsigned by default
    expect(env.sig).toBeUndefined(); // §11.6: intermediate chunks unsigned by default
  });

  it("write() increments chunk_index", () => {
    const writer = createStreamWriter(conn as any, params);
    writer.write("a");
    writer.write("b");
    writer.write("c");

    expect(conn.publish).toHaveBeenCalledTimes(3);
    const chunks = conn.published.map(
      (p) => JSON.parse(new TextDecoder().decode(p.data)).payload.chunk_index,
    );
    expect(chunks).toEqual([0, 1, 2]);
  });

  it("write() includes content_type when provided", () => {
    const writer = createStreamWriter(conn as any, params);
    writer.write("text", "text/plain");

    const env = JSON.parse(new TextDecoder().decode(conn.published[0].data));
    expect(env.payload.content_type).toBe("text/plain");
  });

  it("end() publishes final chunk and task update", () => {
    const writer = createStreamWriter(conn as any, params);
    writer.write("data");
    writer.end("done");

    // 3 publishes: 1 chunk + 1 final chunk + 1 task update
    expect(conn.publish).toHaveBeenCalledTimes(3);

    const finalChunk = JSON.parse(
      new TextDecoder().decode(conn.published[1].data),
    );
    expect(conn.published[1].subject).toBe("mesh.task.task-1.stream");
    expect(finalChunk.payload.final).toBe(true);
    expect(finalChunk.payload.status).toBe("completed");
    expect(finalChunk.payload.data).toBe("done");
    expect(finalChunk.payload.chunk_index).toBe(1);
    // §11.6: the final chunk is signed and brackets the stream.
    expect(finalChunk.sig).toBe("signed-by-test");
    expect(finalChunk.payload.chunk_count).toBe(2);
    // §11.6: the final chunk is signed and brackets the stream.
    expect(finalChunk.sig).toBe("signed-by-test");
    expect(finalChunk.payload.chunk_count).toBe(2);

    const update = JSON.parse(
      new TextDecoder().decode(conn.published[2].data),
    );
    expect(conn.published[2].subject).toBe("mesh.task.task-1.update");
    expect(update.payload.status).toBe("completed");
    expect(update.sig).toBe("signed-by-test");
  });

  it("end() is idempotent", () => {
    const writer = createStreamWriter(conn as any, params);
    writer.end();
    const countAfterFirst = conn.publish.mock.calls.length;
    writer.end();
    expect(conn.publish).toHaveBeenCalledTimes(countAfterFirst);
  });

  it("write() throws after end()", () => {
    const writer = createStreamWriter(conn as any, params);
    writer.end();
    expect(() => writer.write("nope")).toThrow(MeshError);
  });

  it("sets correct envelope fields", () => {
    const writer = createStreamWriter(conn as any, params);
    writer.write("x");

    const env = JSON.parse(new TextDecoder().decode(conn.published[0].data));
    expect(env.type).toBe("respond");
    expect(env.from).toBe("responder-1");
    expect(env.to).toBe("requester-1");
    expect(env.in_reply_to).toBe("req-1");
    expect(env.task_id).toBe("task-1");
    expect(env.trace).toBeDefined();
  });
});

// ─── OfferingRouter Stream Tests ────────────────────────────────────

describe("OfferingRouter stream handlers", () => {
  it("registers and resolves a stream handler", () => {
    const router = new OfferingRouter();
    const handler = async () => {};
    router.registerStream("llm", handler);
    expect(router.resolveStream("llm")).toBe(handler);
  });

  it("returns null for unregistered stream offering", () => {
    const router = new OfferingRouter();
    expect(router.resolveStream("unknown")).toBeNull();
  });

  it("unregisters a stream handler", () => {
    const router = new OfferingRouter();
    router.registerStream("llm", async () => {});
    router.unregisterStream("llm");
    expect(router.resolveStream("llm")).toBeNull();
  });

  it("does not fall back to default for stream handlers", () => {
    const router = new OfferingRouter();
    router.setDefault(async () => "default");
    expect(router.resolveStream("anything")).toBeNull();
  });
});

// ─── createChunkIterable Tests ───────────────────────────────────

describe("createChunkIterable", () => {
  it("yields chunks in order and completes on final", async () => {
    const sub = createMockSubscription();
    const tasks = new TaskTracker();
    tasks.create({
      id: "task-1",
      requester: "req",
      responder: "resp",
      offering: "s",
      state: "working",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      history: [],
      artifacts: [],
    });

    const iterable = createChunkIterable(sub as any, "task-1", tasks, 5000, 30000);

    // Push chunks
    const chunk0 = makeChunkEnvelope({
      status: "working",
      chunk_index: 0,
      final: false,
      data: "hello ",
    });
    const chunk1 = makeChunkEnvelope({
      status: "working",
      chunk_index: 1,
      final: false,
      data: "world",
    });
    const chunkFinal = makeChunkEnvelope({
      status: "completed",
      chunk_index: 2,
      final: true,
      data: null,
      chunk_count: 3,
    });

    sub.push(encode(chunk0));
    sub.push(encode(chunk1));
    sub.push(encode(chunkFinal));

    const received: StreamChunk[] = [];
    for await (const chunk of iterable) {
      received.push(chunk);
    }

    expect(received).toHaveLength(3);
    expect(received[0].chunk_index).toBe(0);
    expect(received[0].data).toBe("hello ");
    expect(received[0].final).toBe(false);
    expect(received[1].chunk_index).toBe(1);
    expect(received[1].data).toBe("world");
    expect(received[2].chunk_index).toBe(2);
    expect(received[2].final).toBe(true);
  });

  it("unsubscribes after final chunk", async () => {
    const sub = createMockSubscription();
    const tasks = new TaskTracker();
    tasks.create({
      id: "task-1",
      requester: "req",
      responder: "resp",
      offering: "s",
      state: "working",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      history: [],
      artifacts: [],
    });

    const iterable = createChunkIterable(sub as any, "task-1", tasks, 5000, 30000);

    sub.push(
      encode(
        makeChunkEnvelope({
          status: "completed",
          chunk_index: 0,
          final: true,
          data: "done",
          chunk_count: 1,
        }),
      ),
    );

    for await (const _ of iterable) {
      // consume
    }

    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it("adds envelopes to task history", async () => {
    const sub = createMockSubscription();
    const tasks = new TaskTracker();
    tasks.create({
      id: "task-1",
      requester: "req",
      responder: "resp",
      offering: "s",
      state: "working",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      history: [],
      artifacts: [],
    });

    const iterable = createChunkIterable(sub as any, "task-1", tasks, 5000, 30000);

    sub.push(
      encode(
        makeChunkEnvelope({
          status: "completed",
          chunk_index: 0,
          final: true,
          data: null,
          chunk_count: 1,
        }),
      ),
    );

    for await (const _ of iterable) {
      // consume
    }

    const task = tasks.get("task-1");
    expect(task!.history).toHaveLength(1);
  });

  it("transitions task state to completed on final chunk", async () => {
    const sub = createMockSubscription();
    const tasks = new TaskTracker();
    tasks.create({
      id: "task-1",
      requester: "req",
      responder: "resp",
      offering: "s",
      state: "working",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      history: [],
      artifacts: [],
    });

    const iterable = createChunkIterable(sub as any, "task-1", tasks, 5000, 30000);

    sub.push(
      encode(
        makeChunkEnvelope({
          status: "completed",
          chunk_index: 0,
          final: true,
          data: null,
          chunk_count: 1,
        }),
      ),
    );

    for await (const _ of iterable) {
      // consume
    }

    expect(tasks.get("task-1")!.state).toBe("completed");
  });

  it("throws on error envelope in stream", async () => {
    const sub = createMockSubscription();
    const tasks = new TaskTracker();
    tasks.create({
      id: "task-1",
      requester: "req",
      responder: "resp",
      offering: "s",
      state: "working",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      history: [],
      artifacts: [],
    });

    const iterable = createChunkIterable(sub as any, "task-1", tasks, 5000, 30000);

    const errEnv = makeSigned({
      type: "respond",
      from: "responder-1",
      to: "requester-1",
      task_id: "task-1",
      trace: newTraceContext(),
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: "Something broke",
        retryable: false,
      },
      payload: { status: "failed", chunk_index: 0, final: true, data: null },
    });

    sub.push(encode(errEnv));

    await expect(async () => {
      for await (const _ of iterable) {
        // should throw
      }
    }).rejects.toThrow(MeshError);

    expect(tasks.get("task-1")!.state).toBe("failed");
  });

  it("throws on chunk timeout", async () => {
    const sub = createMockSubscription();
    const tasks = new TaskTracker();
    tasks.create({
      id: "task-1",
      requester: "req",
      responder: "resp",
      offering: "s",
      state: "working",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      history: [],
      artifacts: [],
    });

    // 50ms chunk timeout, no messages pushed
    const iterable = createChunkIterable(sub as any, "task-1", tasks, 50, 30000);

    await expect(async () => {
      for await (const _ of iterable) {
        // should timeout
      }
    }).rejects.toThrow(/No chunk received/);

    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it("throws on stream timeout", async () => {
    const sub = createMockSubscription();
    const tasks = new TaskTracker();
    tasks.create({
      id: "task-1",
      requester: "req",
      responder: "resp",
      offering: "s",
      state: "working",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      history: [],
      artifacts: [],
    });

    // Stream timeout is enforced via the Math.min of chunk and remaining stream time.
    // With 50ms stream timeout, the remaining time clamps the wait, producing a timeout.
    const iterable = createChunkIterable(sub as any, "task-1", tasks, 10000, 50);

    await expect(async () => {
      for await (const _ of iterable) {
        // should timeout
      }
    }).rejects.toThrow(MeshError);

    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it("includes content_type in yielded chunk", async () => {
    const sub = createMockSubscription();
    const tasks = new TaskTracker();
    tasks.create({
      id: "task-1",
      requester: "req",
      responder: "resp",
      offering: "s",
      state: "working",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      history: [],
      artifacts: [],
    });

    const iterable = createChunkIterable(sub as any, "task-1", tasks, 5000, 30000);

    sub.push(
      encode(
        makeChunkEnvelope({
          status: "completed",
          chunk_index: 0,
          final: true,
          content_type: "text/plain",
          data: "text",
          chunk_count: 1,
        }),
      ),
    );

    const chunks: StreamChunk[] = [];
    for await (const c of iterable) {
      chunks.push(c);
    }

    expect(chunks[0].content_type).toBe("text/plain");
  });
});

// ─── §11.6 stream-level authentication ───────────────────────────

describe("chunk signing rules (§11.6)", () => {
  function makeTasks() {
    const tasks = new TaskTracker();
    tasks.create({
      id: "task-1", requester: "req", responder: "resp", offering: "s",
      state: "working", created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), history: [], artifacts: [],
    });
    return tasks;
  }
  /** An UNSIGNED chunk envelope (the default §11.6 wire shape). */
  function makeUnsignedChunk(payload: StreamChunkPayload) {
    const { sig, ...env } = makeChunkEnvelope(payload) as any;
    return env;
  }

  it("accepts unsigned intermediate chunks by default", async () => {
    const sub = createMockSubscription();
    const iterable = createChunkIterable(sub as any, "task-1", makeTasks(), 5000, 30000);
    sub.push(encode(makeUnsignedChunk({ status: "working", chunk_index: 0, final: false, data: "a" })));
    sub.push(encode(makeChunkEnvelope({ status: "completed", chunk_index: 1, final: true, data: null, chunk_count: 2 })));
    const got: StreamChunk[] = [];
    for await (const c of iterable) got.push(c);
    expect(got).toHaveLength(2);
    expect(got[0].data).toBe("a");
  });

  it("rejects an UNSIGNED final chunk", async () => {
    const sub = createMockSubscription();
    const iterable = createChunkIterable(sub as any, "task-1", makeTasks(), 5000, 30000);
    sub.push(encode(makeUnsignedChunk({ status: "completed", chunk_index: 0, final: true, data: null, chunk_count: 1 })));
    await expect(async () => { for await (const _ of iterable) {/**/} })
      .rejects.toThrow(/Final stream chunk.*unsigned/);
  });

  it("detects truncation via chunk_count on the signed final", async () => {
    const sub = createMockSubscription();
    const iterable = createChunkIterable(sub as any, "task-1", makeTasks(), 5000, 30000);
    // Final claims 3 chunks, but only 2 envelopes (1 chunk + final) arrived.
    sub.push(encode(makeUnsignedChunk({ status: "working", chunk_index: 0, final: false, data: "a" })));
    sub.push(encode(makeChunkEnvelope({ status: "completed", chunk_index: 2, final: true, data: null, chunk_count: 3 })));
    await expect(async () => { for await (const _ of iterable) {/**/} })
      .rejects.toThrow(/incomplete or tampered/);
  });

  // A frame that does not verify is dropped, never fatal (the c05 shape): the
  // subject is public, so treating a bad frame as the end of the stream would
  // hand any publisher a one-message kill switch on somebody else's stream.
  // Each of these pushes the bad frame FIRST, then a real chunk and a real
  // final — so they check two things at once: the bad frame never surfaces, and
  // it never counted, or `chunk_count` on the final would no longer add up.

  it("sign_chunks strict mode drops an unsigned chunk and finishes the stream", async () => {
    const sub = createMockSubscription();
    const iterable = createChunkIterable(sub as any, "task-1", makeTasks(), 5000, 30000, true);
    sub.push(encode(makeUnsignedChunk({ status: "working", chunk_index: 0, final: false, data: "unsigned" })));
    sub.push(encode(makeChunkEnvelope({ status: "working", chunk_index: 0, final: false, data: "a" })));
    sub.push(encode(makeChunkEnvelope({ status: "completed", chunk_index: 1, final: true, data: null, chunk_count: 2 })));
    const got: StreamChunk[] = [];
    for await (const c of iterable) got.push(c);
    expect(got.map((c) => c.data)).toEqual(["a", null]);
  });

  it("drops a chunk whose PRESENT signature is invalid and finishes the stream", async () => {
    const sub = createMockSubscription();
    const iterable = createChunkIterable(sub as any, "task-1", makeTasks(), 5000, 30000);
    const bad = makeChunkEnvelope({ status: "working", chunk_index: 0, final: false, data: "tampered" }) as any;
    bad.sig = bad.sig.slice(0, -4) + "AAAA"; // tamper
    sub.push(encode(bad));
    sub.push(encode(makeChunkEnvelope({ status: "working", chunk_index: 0, final: false, data: "a" })));
    sub.push(encode(makeChunkEnvelope({ status: "completed", chunk_index: 1, final: true, data: null, chunk_count: 2 })));
    const got: StreamChunk[] = [];
    for await (const c of iterable) got.push(c);
    expect(got.map((c) => c.data)).toEqual(["a", null]);
  });

  it("drops a chunk signed by anyone but the responder that opened the stream", async () => {
    const sub = createMockSubscription();
    // The stream belongs to the party whose verified `respond` opened it. A
    // chunk's own signature only ever proved that SOMEBODY signed it.
    const iterable = createChunkIterable(
      sub as any, "task-1", makeTasks(), 5000, 30000, false, testPub("responder-1"),
    );
    sub.push(encode(makeChunkEnvelope({ status: "working", chunk_index: 0, final: false, data: "a" })));
    sub.push(encode(makeChunkEnvelope(
      { status: "working", chunk_index: 1, final: false, data: "substituted" },
      { from: "someone-else" },
    )));
    sub.push(encode(makeChunkEnvelope({ status: "completed", chunk_index: 1, final: true, data: null, chunk_count: 2 })));
    const got: StreamChunk[] = [];
    for await (const c of iterable) got.push(c);
    expect(got.map((c) => c.data)).toEqual(["a", null]);
  });

  it("drops a frame that carries no chunk at all", async () => {
    const sub = createMockSubscription();
    const iterable = createChunkIterable(
      sub as any, "task-1", makeTasks(), 5000, 30000, false, testPub("responder-1"),
    );
    // `payload` is optional in a structurally valid envelope, and an unsigned
    // chunk's `from` is an unverified claim (§11.6) — so these two frames reach
    // the chunk logic while claiming to be the responder. Reading `final` off
    // them used to throw a TypeError out of the caller's for-await: the
    // one-message stream kill, by a route the responder binding cannot see.
    const { payload: _p, ...noPayload } = makeUnsignedChunk({
      status: "working", chunk_index: 0, final: false, data: null,
    }) as any;
    sub.push(encode(noPayload));
    sub.push(encode({ ...noPayload, payload: "not a chunk" } as any));
    sub.push(encode(makeChunkEnvelope({ status: "working", chunk_index: 0, final: false, data: "a" })));
    sub.push(encode(makeChunkEnvelope({ status: "completed", chunk_index: 1, final: true, data: null, chunk_count: 2 })));
    const got: StreamChunk[] = [];
    for await (const c of iterable) got.push(c);
    expect(got.map((c) => c.data)).toEqual(["a", null]);
  });
});
