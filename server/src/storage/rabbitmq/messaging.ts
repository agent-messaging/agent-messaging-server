/**
 * The messaging interface on RabbitMQ (step 9 of
 * docs/agent-messaging-server-plan.md).
 *
 *  - publish: a message on the mesh's topic exchange, its subject the routing
 *    key (subjects.ts). A message id rides as the AMQP `message-id` property.
 *  - subscribe: a queue of the subscriber's own (server-named, exclusive,
 *    gone with the connection) bound to the pattern, consumed without
 *    acknowledgment, which is core NATS's at-most-once live delivery. With a
 *    queue group, the members share one named queue, so each message goes to
 *    one of them.
 *  - request: RabbitMQ's direct reply-to. The request is published with
 *    `mandatory`, so a subject no queue is bound to comes straight back, and
 *    that is the no-responders answer core NATS gives; otherwise the answer is
 *    awaited for the same timeout.
 *  - a reply address passed through a service unchanged (the admission relay
 *    forwards a request with its reply) keeps the direct reply-to name and
 *    the correlation id together (`joinReply`).
 *
 * Order: on NATS a subscribe and a publish on one connection reach the server
 * in the order they were made, so a service can subscribe to a reply subject
 * and publish the request at once. Here setting a subscription up takes
 * several round trips on its own channel, so every operation goes through one
 * queue (`enqueue`), and a publish waits until each subscription asked for
 * before it is bound.
 */
import type { Channel, ConsumeMessage } from "amqplib";
import { randomBytes, randomUUID } from "node:crypto";
import { MESSAGING } from "../marks.js";
import type { BusMessage, BusSubscription, Messaging, PublishOptions, RequestOptions, SubscribeOptions } from "../types.js";
import type { AmqpLink } from "./link.js";
import { bindingKey, DIRECT_REPLY, joinReply, LIVE_EXPIRATION, MESH_EXCHANGE, splitReply, subjectMatches } from "./subjects.js";
import { createHash } from "node:crypto";

/** The errors a request ends with, in the shapes the NATS client used (a
 *  `code` of "503" for no responders, "TIMEOUT" for a timeout). */
export function noResponders(subject: string): Error {
  return Object.assign(new Error(`no responders available for request on ${subject}`), { code: "503" });
}
export function requestTimeout(subject: string): Error {
  return Object.assign(new Error(`TIMEOUT waiting for an answer on ${subject}`), { code: "TIMEOUT" });
}

/** The name of a queue group's shared queue: the group and the subject, as on
 *  NATS, where a group is per subject. */
export function groupQueueName(queue: string, subject: string): string {
  const safe = queue.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120); // cut-ok: a readable label; the hash names the group
  const h = createHash("sha256").update(`${queue}\u0000${subject}`).digest("hex").slice(0, 16); // cut-ok: a fixed-width name
  return `ams.group.${safe}.${h}`;
}

class Inbox<T> {
  private readonly items: T[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  push(x: T): void {
    if (this.ended) return;
    this.items.push(x);
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  async *iterate(): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

interface Pending {
  subject: string;
  resolve(m: BusMessage): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RabbitMqMessaging implements Messaging {
  readonly [MESSAGING] = true;
  /** Every operation, in order (see the header). */
  private chain: Promise<unknown> = Promise.resolve();
  private pubChannel: Channel | null = null;
  private replyChannel: Promise<Channel> | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly subs = new Set<RabbitSubscription>();

  constructor(readonly link: AmqpLink) {
    link.onReconnect(async () => {
      this.pubChannel = null;
      this.replyChannel = null;
      // Requests in flight were answered on the old connection, if at all.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error(`the connection to the broker dropped while waiting for an answer on ${p.subject}`));
      }
      for (const s of this.subs) await s.setUp(true);
    });
  }

  /** Run `op` after everything asked for before it. */
  enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async publisher(): Promise<Channel> {
    if (this.pubChannel) return this.pubChannel;
    const ch = await this.link.channel();
    ch.on("close", () => {
      if (this.pubChannel === ch) this.pubChannel = null;
    });
    this.pubChannel = ch;
    return ch;
  }

  /** Publish straight away on the current publishing channel (the chain's own step). */
  private async send(subject: string, data: Uint8Array | undefined, opts?: PublishOptions): Promise<void> {
    const ch = await this.publisher();
    const props: Record<string, unknown> = {};
    if (opts?.msgId !== undefined) props.messageId = opts.msgId;
    if (opts?.reply !== undefined) {
      const { replyTo, correlationId } = splitReply(opts.reply);
      props.replyTo = replyTo;
      if (correlationId) props.correlationId = correlationId;
    }
    ch.publish(MESH_EXCHANGE, subject, Buffer.from(data ?? new Uint8Array(0)), props);
  }

  publish(subject: string, data?: Uint8Array, opts?: PublishOptions): void {
    void this.enqueue(() => this.send(subject, data, opts)).catch((err) =>
      console.error(`[amqp] publish on ${subject} failed:`, err instanceof Error ? err.message : err),
    );
  }

  /** Answer a message: through the default exchange to a direct reply-to
   *  name, else on the exchange to a reply subject. */
  respondTo(reply: string, data: Uint8Array | undefined): void {
    const { replyTo, correlationId } = splitReply(reply);
    void this.enqueue(async () => {
      const ch = await this.publisher();
      const body = Buffer.from(data ?? new Uint8Array(0));
      if (replyTo.startsWith(DIRECT_REPLY)) ch.publish("", replyTo, body, correlationId ? { correlationId } : {});
      else ch.publish(MESH_EXCHANGE, replyTo, body, correlationId ? { correlationId } : {});
    }).catch((err) => console.error(`[amqp] reply failed:`, err instanceof Error ? err.message : err));
  }

  message(subject: string, content: Buffer, replyTo?: string, correlationId?: string): BusMessage {
    const reply = joinReply(replyTo, correlationId);
    const data = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    return {
      subject,
      data,
      reply,
      respond: (d?: Uint8Array) => {
        if (!reply) return false;
        this.respondTo(reply, d);
        return true;
      },
    };
  }

  subscribe(subject: string, opts?: SubscribeOptions): BusSubscription {
    const sub = new RabbitSubscription(this, subject, opts?.queue);
    this.subs.add(sub);
    sub.onEnd(() => this.subs.delete(sub));
    void this.enqueue(() => sub.setUp(false)).catch((err) => {
      console.error(`[amqp] subscribe to ${subject} failed:`, err instanceof Error ? err.message : err);
      sub.unsubscribe();
    });
    return sub;
  }

  private replies(): Promise<Channel> {
    if (this.replyChannel) return this.replyChannel;
    const p = (async () => {
      const ch = await this.link.channel();
      ch.on("close", () => {
        if (this.replyChannel === p) this.replyChannel = null;
      });
      ch.on("return", (m: ConsumeMessage) => {
        const id = m.properties.correlationId as string | undefined;
        const w = id ? this.pending.get(id) : undefined;
        if (!w) return;
        clearTimeout(w.timer);
        this.pending.delete(id!);
        w.reject(noResponders(w.subject));
      });
      await ch.consume(
        DIRECT_REPLY,
        (m) => {
          if (!m) return;
          const id = m.properties.correlationId as string | undefined;
          const w = id ? this.pending.get(id) : undefined;
          if (!w) return;
          clearTimeout(w.timer);
          this.pending.delete(id!);
          w.resolve(this.message(m.fields.routingKey, m.content));
        },
        { noAck: true },
      );
      return ch;
    })();
    this.replyChannel = p;
    p.catch(() => {
      if (this.replyChannel === p) this.replyChannel = null;
    });
    return p;
  }

  request(subject: string, data: Uint8Array, opts: RequestOptions): Promise<BusMessage> {
    return new Promise<BusMessage>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(requestTimeout(subject));
      }, opts.timeout);
      this.pending.set(id, { subject, resolve, reject, timer });
      void this.enqueue(async () => {
        const ch = await this.replies();
        // Published on the channel that consumes the replies, as direct
        // reply-to requires; `mandatory` makes an unroutable request come back.
        // A live request expires in any queue that cannot hand it to a
        // consumer at once (an away agent's mailbox), and the capture never
        // keeps it (capture.ts).
        ch.publish(MESH_EXCHANGE, subject, Buffer.from(data), {
          replyTo: DIRECT_REPLY,
          correlationId: id,
          mandatory: true,
          ...(opts.live ? { expiration: LIVE_EXPIRATION } : {}),
        });
      }).catch((err) => {
        const w = this.pending.get(id);
        if (!w) return;
        clearTimeout(w.timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  newInbox(): string {
    // NATS's own shape (_INBOX.<22 characters>), routed on the exchange.
    return `_INBOX.${randomBytes(16).toString("base64url").replace(/[-_]/g, "x").slice(0, 22)}`; // cut-ok: a fixed-length random token
  }

  /** Wait until everything asked for so far has been done. */
  flush(): Promise<void> {
    return this.enqueue(async () => undefined);
  }
}

export class RabbitSubscription implements BusSubscription {
  private readonly inbox = new Inbox<BusMessage>();
  private channel: Channel | null = null;
  private ended = false;
  private readonly endCbs: (() => void)[] = [];

  constructor(
    private readonly bus: RabbitMqMessaging,
    readonly subject: string,
    private readonly queue?: string,
  ) {}

  onEnd(fn: () => void): void {
    this.endCbs.push(fn);
  }

  /** Make the queue, bind it and consume: at first, and again after a reconnect. */
  async setUp(restoring: boolean): Promise<void> {
    if (this.ended) return;
    const ch = await this.bus.link.channel(restoring);
    this.channel = ch;
    let q: string;
    if (this.queue) {
      q = groupQueueName(this.queue, this.subject);
      // Durable because RabbitMQ 4 refuses a shared queue that is not; it is
      // still removed when its last member goes.
      await ch.assertQueue(q, { durable: true, exclusive: false, autoDelete: true });
    } else {
      q = (await ch.assertQueue("", { durable: false, exclusive: true, autoDelete: true })).queue;
    }
    await ch.bindQueue(q, MESH_EXCHANGE, bindingKey(this.subject));
    await ch.consume(
      q,
      (m) => {
        if (!m) return;
        // Only what came on a subject this subscription asked for (subjects.ts).
        if (!subjectMatches(this.subject, m.fields.routingKey)) return;
        this.inbox.push(this.bus.message(m.fields.routingKey, m.content, m.properties.replyTo, m.properties.correlationId));
      },
      { noAck: true },
    );
    if (this.ended) await ch.close().catch(() => undefined);
  }

  [Symbol.asyncIterator](): AsyncIterator<BusMessage> {
    return this.inbox.iterate();
  }

  unsubscribe(): void {
    if (this.ended) return;
    this.ended = true;
    this.inbox.end();
    const ch = this.channel;
    // After anything already asked for, so an unsubscribe right after a
    // subscribe does not race the setup.
    void this.bus.enqueue(async () => {
      await (this.channel ?? ch)?.close().catch(() => undefined);
    });
    for (const fn of this.endCbs) fn();
  }
}
