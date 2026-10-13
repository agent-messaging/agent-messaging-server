/**
 * "Discard what was held" keeps the mail that was waiting before the stop
 * (debt 171, owner's answer of 2026-10-01). InboxBuffer.discard takes the
 * stop's start and deletes only the messages that arrived at or after it;
 * countSince is the Resume dialog's count of the same messages.
 */
import { describe, it, expect } from "vitest";
import { InboxBuffer, inboxStreamName } from "../../src/registry/inbox-buffer.js";

const AGENT = `U${"A".repeat(55)}`;
const STOP = Date.parse("2026-10-01T12:00:00.000Z");

/** A fake JetStream manager over one stream: seq -> arrival time. */
function fakeNc(times: Record<number, number>, lifecycle: number[] = []) {
  const msgs = new Map<number, number>(Object.entries(times).map(([k, v]) => [Number(k), v]));
  const deleted: number[] = [];
  const jsm = {
    streams: {
      info: async (name: string) => {
        if (name !== inboxStreamName(AGENT)) throw new Error("stream not found");
        const seqs = [...msgs.keys()];
        return { state: { messages: seqs.length, first_seq: seqs.length ? Math.min(...seqs) : 0, last_seq: seqs.length ? Math.max(...seqs) : 0 } };
      },
      getMessage: async (_name: string, q: { seq: number }) => {
        const t = msgs.get(q.seq);
        if (t === undefined) throw new Error("no message found");
        const text = lifecycle.includes(q.seq) ? "agentmesh-lifecycle/v1\npause" : "hello";
        return { seq: q.seq, time: new Date(t), data: new TextEncoder().encode(JSON.stringify({ type: "request", payload: { text } })) };
      },
      deleteMessage: async (_name: string, seq: number) => { msgs.delete(seq); deleted.push(seq); return true; },
      purge: async () => { throw new Error("purge must not be used"); },
    },
  };
  return { nc: { jetstreamManager: async () => jsm } as never, msgs, deleted };
}

describe("InboxBuffer.discard keeps mail from before the stop", () => {
  it("deletes only what arrived at or after the stop's start, newest first, and says how many", async () => {
    // 1-3 waited before the pause (an agent that was simply offline); 5 is a
    // gap; 4, 6 and 7 arrived while paused.
    const { nc, msgs, deleted } = fakeNc({ 1: STOP - 3_600_000, 2: STOP - 60_000, 3: STOP - 1, 4: STOP, 6: STOP + 5_000, 7: STOP + 9_000 });
    const buf = new InboxBuffer(nc);
    expect(await buf.countSince(AGENT, STOP)).toBe(3);
    expect(await buf.discard(AGENT, STOP)).toBe(3);
    expect(deleted).toEqual([7, 6, 4]);
    expect([...msgs.keys()].sort()).toEqual([1, 2, 3]);
  });

  it("the stop's own lifecycle request is discarded with the rest but never counted as mail", async () => {
    // 3 is the platform's "pause" sent as the stop started; 4 and 5 were sent.
    const { nc, msgs } = fakeNc({ 1: STOP - 60_000, 3: STOP + 200, 4: STOP + 5_000, 5: STOP + 9_000 }, [3]);
    const buf = new InboxBuffer(nc);
    expect(await buf.countSince(AGENT, STOP)).toBe(2);
    expect(await buf.discard(AGENT, STOP)).toBe(2);
    expect([...msgs.keys()]).toEqual([1]);
  });

  it("a mailbox with nothing new loses nothing", async () => {
    const { nc, deleted } = fakeNc({ 1: STOP - 10, 2: STOP - 5 });
    expect(await new InboxBuffer(nc).discard(AGENT, STOP)).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("no mailbox is zero, not a failure", async () => {
    const { nc } = fakeNc({});
    expect(await new InboxBuffer(nc).discard(`U${"B".repeat(55)}`, STOP)).toBe(0);
    expect(await new InboxBuffer(nc).countSince(AGENT, STOP)).toBe(0);
  });
});
