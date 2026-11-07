// A stream in memory with durable consumers, for tests of what reads one
// (task-manager/a2a-follow.ts). Messages are appended in order; a consumer
// made with `from: "all"` starts at the first, keeps its place by name, and
// waits for more.
import type { ConsumeOptions, StreamConsumer, StreamDelivery, StreamStore } from "../../src/storage/index.js";

function matches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return s.length > i;
    if (i >= s.length || (p[i] !== "*" && p[i] !== s[i])) return false;
  }
  return p.length === s.length;
}

export function memoryStream(name = "MESH_TASKS"): StreamStore & {
  push(subject: string, data: Uint8Array): void;
  consumers: Map<string, number>;
  removed: string[];
} {
  const messages: { subject: string; data: Uint8Array; seq: number }[] = [];
  const consumers = new Map<string, number>(); // durable -> next index
  const waiters = new Set<() => void>();
  const removed: string[] = [];
  const wake = () => {
    for (const w of [...waiters]) w();
  };
  return {
    name,
    consumers,
    removed,
    push(subject, data) {
      messages.push({ subject, data, seq: messages.length + 1 });
      wake();
    },
    async info() {
      return null;
    },
    async create() {},
    async reconfigure() {},
    async append(subject, data) {
      messages.push({ subject, data, seq: messages.length + 1 });
      wake();
      return messages.length;
    },
    async read(seq) {
      const m = messages[seq - 1];
      if (!m) throw new Error("no message");
      return { ...m, time: new Date() };
    },
    async *readFrom() {},
    async removeMessage() {},
    async purge() {},
    async destroy() {},
    async consumerState() {
      return { pending: 0, ackPending: 0, ackFloor: 0 };
    },
    async removeConsumer(durable) {
      consumers.delete(durable);
      removed.push(durable);
    },
    async consume(durable: string, opts: ConsumeOptions = {}): Promise<StreamConsumer> {
      if (!consumers.has(durable)) consumers.set(durable, 0);
      let stopped = false;
      const it: StreamConsumer = {
        stop() {
          stopped = true;
          wake();
        },
        async close() {
          stopped = true;
          wake();
        },
        async *[Symbol.asyncIterator](): AsyncIterator<StreamDelivery> {
          while (!stopped) {
            const i = consumers.get(durable) ?? 0;
            const m = messages[i];
            if (!m) {
              await new Promise<void>((resolve) => {
                const w = () => {
                  waiters.delete(w);
                  resolve();
                };
                waiters.add(w);
              });
              continue;
            }
            consumers.set(durable, i + 1);
            if (opts.filter && !matches(opts.filter, m.subject)) continue;
            yield { subject: m.subject, data: m.data, seq: m.seq, ack() {}, nak() {} };
          }
        },
      } as unknown as StreamConsumer;
      return it;
    },
  } as StreamStore & { push(subject: string, data: Uint8Array): void; consumers: Map<string, number>; removed: string[] };
}
