/**
 * The AMQP transport: the SDK on a mesh that runs Agent Messaging's RabbitMQ
 * binding (docs/agent-messaging-server-plan.md, steps 9 and 10, and the
 * binding document, docs/rabbitmq-binding.md).
 *
 * It has the same shape as `ConnectionManager` (the NATS transport), so the
 * agent and node code above it runs unchanged, and it says which it is in
 * `binding`. What differs is underneath:
 *
 *  - a subject is the routing key on the mesh's topic exchange `mesh`; a
 *    subscription is a server-named exclusive queue bound to the pattern, with
 *    `>` written `*.#` (one word, then any number);
 *  - a request goes out through RabbitMQ's direct reply-to, `mandatory`, so a
 *    subject nobody listens on comes straight back as no responders;
 *  - the connection authenticates with the node credential the key chain
 *    minted: user name `<node key>:<jti>`, password `<jwt>~<unix ms>~<sig>`,
 *    the signature made by the credential's key (through the same
 *    authenticator the NATS transport is given) over
 *    `amqp-connect|<user name>|<unix ms>`;
 *  - an agent's mailbox is a durable queue (`MESH_INBOX_<agent>`) the node
 *    consumes with acknowledgment, and durable subscriptions are durable
 *    queues named as the reference binding names its consumers.
 *
 * amqplib is loaded only when an AMQP mesh is dialled, and it needs Node.
 */
import type { ConnectOptions } from "../types/options.js";
import { MeshError, ErrorCode } from "../types/errors.js";

/** The topic exchange every subject is published on. */
export const MESH_EXCHANGE = "mesh";
const DIRECT_REPLY = "amq.rabbitmq.reply-to";
/** The largest message the binding carries (its broker sets max_message_size). */
export const AMQP_MAX_PAYLOAD = 1_048_576;

/* eslint-disable @typescript-eslint/no-explicit-any */
type AmqpConn = any;
type AmqpChannel = any;
type AmqpMessage = any;

/** A subscription pattern as an AMQP binding key (`>` becomes `*.#`). */
export function bindingKey(pattern: string): string {
  return pattern
    .split(".")
    .map((t) => (t === ">" ? "*.#" : t))
    .join(".");
}

/**
 * Whether a delivery came on a subject: published to the mesh's topic
 * exchange, which is the only place a routing key is a subject and the broker
 * checks the sender's publish permission on it. RabbitMQ also lets any
 * connection publish into a queue by its name through the default exchange
 * (the binding needs that exchange for direct reply-to answers, and RabbitMQ
 * checks routing keys only on topic exchanges, so the broker cannot refuse
 * one and allow the other). Such a message never came on a subject, so every
 * consumer of a queue bound to `mesh` drops it (binding document §2.1).
 */
export function cameOnSubject(m: { fields?: { exchange?: unknown } } | null | undefined): boolean {
  return m?.fields?.exchange === MESH_EXCHANGE;
}

/** Whether `subject` matches `pattern` (SPEC §14.2). */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    const t = p[i]!;
    if (t === ">") return s.length > i;
    if (i >= s.length) return false;
    if (t !== "*" && t !== s[i]) return false;
  }
  return p.length === s.length;
}

const te = new TextEncoder();
const td = new TextDecoder();

/** amqplib takes a Node Buffer; a view over the same bytes, not a copy. */
function buf(d: Uint8Array): Uint8Array {
  const B = (globalThis as unknown as { Buffer: { from(a: ArrayBufferLike, o: number, l: number): Uint8Array } }).Buffer;
  return B.from(d.buffer, d.byteOffset, d.byteLength);
}

function b64urlDecode(seg: string): string {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((seg.length + 3) % 4);
  return td.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

/** The user name and password an AMQP connection presents, from what the
 *  NATS transport is given: an authenticator (jwtAuthenticator), which signs
 *  the proof the way it signs a NATS server's nonce. */
export function amqpLogin(authenticator: (nonce?: string) => unknown, nowMs: number = Date.now()): { user: string; password: string } {
  const probe = authenticator(undefined) as { jwt?: string; nkey?: string };
  const jwt = probe?.jwt;
  // No credential: present the key alone, which the broker refuses, as a
  // NATS server refuses a connection that brings no JWT.
  if (!jwt) return { user: probe?.nkey || "anonymous", password: "no-credential" };
  const claims = JSON.parse(b64urlDecode(jwt.split(".")[1] ?? "")) as { sub?: string; jti?: string };
  if (!claims.sub || !claims.jti) throw new MeshError(ErrorCode.TRANSPORT_PERMISSION_DENIED, "the credential names no key (sub) or id (jti)");
  const user = `${claims.sub}:${claims.jti}`;
  const signed = authenticator(`amqp-connect|${user}|${nowMs}`) as { sig?: string };
  if (!signed?.sig) throw new MeshError(ErrorCode.TRANSPORT_PERMISSION_DENIED, "the credential's key could not sign the connection proof");
  return { user, password: `${jwt}~${nowMs}~${signed.sig}` };
}

/** One message as the agent code reads it: the NATS `Msg` fields it uses. */
interface AmqpMsg {
  subject: string;
  data: Uint8Array;
  reply?: string;
  sid: number;
  headers?: undefined;
  respond(data?: Uint8Array): boolean;
  json<T>(): T;
  string(): string;
}

type Handler = (msg: AmqpMsg) => void;

interface Sub {
  subject: string;
  handler: Handler | null;
  queue: Inbox | null;
  channel: AmqpChannel | null;
  closed: boolean;
}

class Inbox {
  private items: AmqpMsg[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  push(m: AmqpMsg): void {
    if (this.ended) return;
    this.items.push(m);
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  async *iterate(): AsyncGenerator<AmqpMsg> {
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

/** A subscription handle with the methods agent code calls on a NATS one. */
export interface AmqpSubscription extends AsyncIterable<AmqpMsg> {
  unsubscribe(): void;
  getSubject(): string;
  isClosed(): boolean;
  drain(): Promise<void>;
}

/** A durable consumer's delivery (mailbox, durable subscription). */
export interface AmqpDelivery {
  subject: string;
  data: Uint8Array;
  /** Where the sender asked for an answer (a probe, a guarded delivery's
   *  relay), with its correlation id, as a live subscription gives it. */
  reply?: string;
  /** Answer on `reply`; false when the sender asked for none. */
  respond(data?: Uint8Array): boolean;
  /** The queue held it before this consumer attached (the backlog of an agent
   *  that was away), or the broker is handing it out again. */
  backlog: boolean;
  ack(): void;
  nak(delayMs?: number): void;
}

export interface AmqpConsumer extends AsyncIterable<AmqpDelivery> {
  stop(): void;
}

export class AmqpConnection {
  readonly binding = "amqp" as const;
  private conn: AmqpConn | null = null;
  private pub: AmqpChannel | null = null;
  private replies: Promise<AmqpChannel> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly subs = new Set<Sub>();
  private readonly consumers = new Set<{ restore(): Promise<void> }>();
  private readonly pending = new Map<string, { onMsg(m: AmqpMsg): void; onReturn(): void }>();
  private readonly reconnectCbs = new Set<() => void>();
  private closedFlag = false;
  private reconnecting = false;
  private sidSeq = 0;

  private constructor(
    private readonly amqp: { connect(url: string, opts?: unknown): Promise<AmqpConn> },
    private readonly url: string,
    private readonly login: () => { user: string; password: string },
    private readonly opts: ConnectOptions,
  ) {}

  static async connect(opts: ConnectOptions): Promise<AmqpConnection> {
    const servers = Array.isArray(opts.servers) ? opts.servers : [opts.servers];
    const url = servers.find((s) => /^amqps?:\/\//i.test(s));
    if (!url) throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "no amqp:// address to dial");
    let amqp: { connect(url: string, o?: unknown): Promise<AmqpConn> };
    try {
      const mod = (await import("amqplib")) as unknown as { default?: typeof amqp } & typeof amqp;
      amqp = typeof mod.connect === "function" ? mod : mod.default!;
    } catch (err) {
      throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "this mesh speaks AMQP, and the amqplib package could not be loaded (it needs Node)", {
        cause: err as Error,
      });
    }
    const login = () => {
      if (opts.authenticator) return amqpLogin(opts.authenticator as (n?: string) => unknown);
      if (opts.auth?.user && opts.auth.pass) return { user: opts.auth.user, password: opts.auth.pass };
      throw new MeshError(ErrorCode.TRANSPORT_PERMISSION_DENIED, "an AMQP mesh needs a node credential to connect");
    };
    const c = new AmqpConnection(amqp, url, login, opts);
    await c.dial();
    return c;
  }

  private async dial(): Promise<void> {
    const { user, password } = this.login();
    const u = new URL(this.url);
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(password);
    if (!u.searchParams.has("heartbeat")) u.searchParams.set("heartbeat", "20");
    let conn: AmqpConn;
    try {
      conn = await this.amqp.connect(u.toString(), { clientProperties: { connection_name: this.opts.name ?? "agent-messaging-sdk" } });
    } catch (err) {
      const m = (err as Error)?.message ?? String(err);
      throw new MeshError(
        /ACCESS_REFUSED|403|auth/i.test(m) ? ErrorCode.TRANSPORT_PERMISSION_DENIED : ErrorCode.TRANSPORT_TIMEOUT,
        `Failed to connect to AMQP: ${m}`,
        { cause: err as Error },
      );
    }
    conn.on("error", () => undefined);
    conn.on("close", () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.pub = null;
      this.replies = null;
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.onReturn();
      }
      if (!this.closedFlag) void this.reconnect();
    });
    this.conn = conn;
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closedFlag || this.opts.reconnect === false) {
      if (this.opts.reconnect === false) this.closedFlag = true;
      return;
    }
    this.reconnecting = true;
    const attempts = this.opts.maxReconnectAttempts ?? 10;
    const wait = this.opts.reconnectTimeWait ?? 2000;
    try {
      for (let i = 0; attempts < 0 || i < attempts; i++) {
        if (this.closedFlag) return;
        await new Promise((r) => setTimeout(r, wait));
        try {
          await this.dial();
          for (const s of this.subs) await this.setUp(s).catch(() => undefined);
          for (const c of this.consumers) await c.restore().catch(() => undefined);
          for (const cb of [...this.reconnectCbs]) {
            try {
              cb();
            } catch {
              /* the callback's problem */
            }
          }
          return;
        } catch {
          /* try again */
        }
      }
      this.closedFlag = true;
    } finally {
      this.reconnecting = false;
    }
  }

  private async channel(): Promise<AmqpChannel> {
    if (!this.conn) throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "the AMQP connection is not open");
    const ch = await this.conn.createChannel();
    // A refused operation closes its channel with ACCESS_REFUSED. NATS reports
    // a permission violation as a status event and carries on; so does this.
    ch.on("error", (err: Error) => {
      const m = err?.message ?? String(err);
      if (/ACCESS.REFUSED|\b403\b/.test(m)) this.emitStatus({ type: "error", error: `Permissions Violation: ${m}`, data: `Permissions Violation: ${m}` });
    });
    return ch;
  }

  private readonly statusQueues = new Set<{ push(e: { type: string; data?: unknown; error?: unknown }): void }>();

  private emitStatus(e: { type: string; data?: unknown; error?: unknown }): void {
    for (const q of this.statusQueues) q.push(e);
  }

  private checkSize(subject: string, data: Uint8Array | undefined): void {
    const n = data?.byteLength ?? 0;
    if (n > AMQP_MAX_PAYLOAD) {
      throw new MeshError(ErrorCode.PAYLOAD_TOO_LARGE, `MAX_PAYLOAD_EXCEEDED: ${n} bytes on '${subject}' is over this mesh's ${AMQP_MAX_PAYLOAD}`);
    }
  }

  /** Run `op` after everything asked for before it (a subscription is bound
   *  before a later publish goes out, as on one NATS connection). */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async publisher(): Promise<AmqpChannel> {
    if (this.pub) return this.pub;
    const ch = await this.channel();
    ch.on("close", () => {
      if (this.pub === ch) this.pub = null;
    });
    this.pub = ch;
    return ch;
  }

  private msg(subject: string, content: Uint8Array, replyTo?: string, correlationId?: string): AmqpMsg {
    const data = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    const reply = replyTo ? (correlationId ? `${replyTo}#${correlationId}` : replyTo) : undefined;
    return {
      subject,
      data,
      reply,
      sid: 0,
      respond: (d?: Uint8Array) => {
        if (!reply) return false;
        this.respondTo(reply, d);
        return true;
      },
      json: <T>() => JSON.parse(td.decode(data)) as T,
      string: () => td.decode(data),
    };
  }

  private respondTo(reply: string, data?: Uint8Array): void {
    const i = reply.indexOf("#");
    const direct = reply.startsWith(DIRECT_REPLY);
    const to = direct && i > 0 ? reply.slice(0, i) : reply;
    const correlationId = direct && i > 0 ? reply.slice(i + 1) : undefined;
    void this.enqueue(async () => {
      const ch = await this.publisher();
      const body = data ?? new Uint8Array(0);
      ch.publish(direct ? "" : MESH_EXCHANGE, to, buf(body), correlationId ? { correlationId } : {});
    }).catch(() => undefined);
  }

  publish(subject: string, data: Uint8Array, opts?: { headers?: Record<string, string>; reply?: string }): void {
    if (this.closedFlag) throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "the AMQP connection is closed");
    this.checkSize(subject, data);
    const props: Record<string, unknown> = {};
    const id = opts?.headers?.["Nats-Msg-Id"];
    if (id) props.messageId = id;
    if (opts?.reply) {
      // A reply subject routed on the exchange (`_INBOX.…`), or a direct
      // reply-to address passed along with its correlation id.
      const i = opts.reply.indexOf("#");
      if (opts.reply.startsWith(DIRECT_REPLY) && i > 0) {
        props.replyTo = opts.reply.slice(0, i);
        props.correlationId = opts.reply.slice(i + 1);
      } else props.replyTo = opts.reply;
    }
    void this.enqueue(async () => {
      const ch = await this.publisher();
      ch.publish(MESH_EXCHANGE, subject, buf(data), props);
    }).catch(() => undefined);
  }

  private replyChannel(): Promise<AmqpChannel> {
    if (this.replies) return this.replies;
    const p = (async () => {
      const ch = await this.channel();
      ch.on("return", (m: AmqpMessage) => {
        const w = this.pending.get(m.properties?.correlationId);
        if (w) w.onReturn();
      });
      ch.on("close", () => {
        if (this.replies === p) this.replies = null;
      });
      await ch.consume(
        DIRECT_REPLY,
        (m: AmqpMessage) => {
          if (!m) return;
          const w = this.pending.get(m.properties?.correlationId);
          if (w) w.onMsg(this.msg(m.fields.routingKey, m.content));
        },
        { noAck: true },
      );
      return ch;
    })();
    this.replies = p;
    p.catch(() => {
      if (this.replies === p) this.replies = null;
    });
    return p;
  }

  /** A request whose replies `onMsg` sees until `stop`; `onReturn` when
   *  nobody listens on the subject. */
  private send(subject: string, data: Uint8Array, onMsg: (m: AmqpMsg) => void, onReturn: () => void): { stop(): void; sent: Promise<void> } {
    try {
      this.checkSize(subject, data);
    } catch (err) {
      return { stop: () => undefined, sent: Promise.reject(err) };
    }
    const id = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
    this.pending.set(id, { onMsg, onReturn });
    const sent = this.enqueue(async () => {
      const ch = await this.replyChannel();
      ch.publish(MESH_EXCHANGE, subject, buf(data), { replyTo: DIRECT_REPLY, correlationId: id, mandatory: true });
    });
    return { stop: () => this.pending.delete(id), sent };
  }

  async request(subject: string, data: Uint8Array, opts?: { timeout?: number }): Promise<AmqpMsg> {
    const timeout = opts?.timeout ?? 5000;
    return await new Promise<AmqpMsg>((resolve, reject) => {
      let done = false;
      const finish = (err: unknown, m?: AmqpMsg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        h.stop();
        if (m) resolve(m);
        else reject(err);
      };
      const timer = setTimeout(() => finish(new MeshError(ErrorCode.TRANSPORT_TIMEOUT, `Request timed out on subject '${subject}'`)), timeout);
      const h = this.send(
        subject,
        data,
        (m) => finish(undefined, m),
        () => finish(new MeshError(ErrorCode.TRANSPORT_NO_RESPONDERS, `No responders on subject '${subject}'`)),
      );
      h.sent.catch((err) => finish(err));
    });
  }

  /** As `ConnectionManager.requestMulti`: several replies to one request. */
  async requestMulti(
    subject: string,
    data: Uint8Array,
    opts: {
      timeout: number;
      classify: (msg: AmqpMsg) => "resolve" | "ignore" | "reset" | { reject: unknown };
      onListen?: (stop: () => void) => void;
    },
  ): Promise<AmqpMsg> {
    return await new Promise<AmqpMsg>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (err: unknown, m?: AmqpMsg) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        h.stop();
        if (m) resolve(m);
        else reject(err);
      };
      const onTimeout = () => finish(new MeshError(ErrorCode.TRANSPORT_TIMEOUT, `Request timed out on subject '${subject}'`));
      timer = setTimeout(onTimeout, opts.timeout);
      const h = this.send(
        subject,
        data,
        (m) => {
          if (done) return;
          let v: ReturnType<typeof opts.classify>;
          try {
            v = opts.classify(m);
          } catch (e) {
            finish(e);
            return;
          }
          if (v === "resolve") finish(undefined, m);
          else if (v === "reset") {
            if (timer) clearTimeout(timer);
            timer = setTimeout(onTimeout, opts.timeout);
          } else if (typeof v === "object") finish(v.reject);
        },
        () => finish(new MeshError(ErrorCode.TRANSPORT_NO_RESPONDERS, `No responders on subject '${subject}'`)),
      );
      opts.onListen?.(() => finish(new MeshError(ErrorCode.TRANSPORT_TIMEOUT, `Reply-subject watch on '${subject}' was stopped by its caller`)));
      h.sent.catch((err) => finish(err));
    });
  }

  private async setUp(s: Sub): Promise<void> {
    if (s.closed) return;
    const ch = await this.channel();
    s.channel = ch;
    const q = (await ch.assertQueue("", { exclusive: true, autoDelete: true, durable: false })).queue as string;
    await ch.bindQueue(q, MESH_EXCHANGE, bindingKey(s.subject));
    await ch.consume(
      q,
      (m: AmqpMessage) => {
        if (!m || s.closed) return;
        if (!cameOnSubject(m) || !subjectMatches(s.subject, m.fields.routingKey)) return;
        const msg = this.msg(m.fields.routingKey, m.content, m.properties?.replyTo, m.properties?.correlationId);
        msg.sid = ++this.sidSeq;
        if (s.handler) {
          try {
            s.handler(msg);
          } catch {
            /* a handler's failure does not end the subscription */
          }
        } else s.queue?.push(msg);
      },
      { noAck: true },
    );
    if (s.closed) await ch.close().catch(() => undefined);
  }

  private makeSub(subject: string, handler: Handler | null): AmqpSubscription {
    const s: Sub = { subject, handler, queue: handler ? null : new Inbox(), channel: null, closed: false };
    this.subs.add(s);
    void this.enqueue(() => this.setUp(s)).catch(() => {
      // Refused (a permission) or the connection went: the subscription ends.
      s.closed = true;
      s.queue?.end();
      this.subs.delete(s);
    });
    const unsubscribe = () => {
      if (s.closed) return;
      s.closed = true;
      s.queue?.end();
      this.subs.delete(s);
      void this.enqueue(async () => {
        await s.channel?.close().catch(() => undefined);
      });
    };
    return {
      unsubscribe,
      getSubject: () => subject,
      isClosed: () => s.closed,
      drain: async () => unsubscribe(),
      [Symbol.asyncIterator]: () => (s.queue ?? new Inbox()).iterate(),
    };
  }

  subscribe(subject: string, handler: (msg: AmqpMsg) => void): AmqpSubscription {
    return this.makeSub(subject, handler);
  }

  /** The NATS-connection-shaped object a few callers reach for (`raw`):
   *  subscribe as an iterable, publish, request. JetStream is not here. */
  get raw(): {
    subscribe(subject: string): AmqpSubscription;
    publish(subject: string, data?: Uint8Array): void;
    request(subject: string, data: Uint8Array, opts?: { timeout?: number }): Promise<AmqpMsg>;
  } {
    return {
      subscribe: (subject: string) => this.makeSub(subject, null),
      publish: (subject: string, data?: Uint8Array) => this.publish(subject, data ?? new Uint8Array(0)),
      request: (subject, data, opts) => this.request(subject, data, opts),
    };
  }

  /** Whether a queue exists (an agent's mailbox, a durable subscription). */
  async queueExists(name: string): Promise<boolean> {
    return (await this.queueInfo(name)) !== null;
  }

  /** Remove a durable subscription's queue (its cursor, and what it holds). */
  async deleteQueue(name: string): Promise<void> {
    const ch = await this.channel();
    try {
      await ch.deleteQueue(name);
    } finally {
      await ch.close().catch(() => undefined);
    }
  }

  /** What a queue holds now (messages ready, consumers), or null when there
   *  is no such queue or this credential may not see it. */
  async queueInfo(name: string): Promise<{ messages: number; consumers: number } | null> {
    const ch = await this.channel();
    try {
      const q = await ch.checkQueue(name);
      return { messages: q.messageCount, consumers: q.consumerCount };
    } catch {
      return null;
    } finally {
      await ch.close().catch(() => undefined);
    }
  }

  /**
   * Consume a durable queue with acknowledgment: an agent's mailbox, or a
   * durable subscription's queue (made and bound here when `bind` is given).
   * A delivery not acknowledged comes again: `nak(delay)` puts it back after
   * the delay, and one never settled comes again when the channel or the
   * connection ends. Restored after a reconnect.
   */
  async consume(queue: string, opts: { bind?: string[]; prefetch?: number } = {}): Promise<AmqpConsumer & { bind(pattern: string): Promise<void> }> {
    const inbox = new (class {
      items: AmqpDelivery[] = [];
      wake: (() => void) | null = null;
      ended = false;
    })();
    let ch: AmqpChannel | null = null;
    let stopped = false;
    const bindings = new Set(opts.bind ?? []);
    const open = async () => {
      if (stopped) return;
      const c = await this.channel();
      // What the queue holds as this consumer attaches: the first that many
      // deliveries are its backlog (the queue hands them over in order).
      let backlog: number;
      if (opts.bind) {
        backlog = Number((await c.assertQueue(queue, { durable: true }))?.messageCount ?? 0);
        for (const b of bindings) await c.bindQueue(queue, MESH_EXCHANGE, bindingKey(b));
      } else {
        backlog = Number((await c.checkQueue(queue))?.messageCount ?? 0);
      }
      await c.prefetch(opts.prefetch ?? 32);
      await c.consume(queue, (m: AmqpMessage) => {
        if (!m) {
          // The queue was deleted: the consumer ends.
          inbox.ended = true;
          inbox.wake?.();
          return;
        }
        let settled = false;
        const early = backlog > 0;
        if (early) backlog--;
        // Put into the queue by its name, not sent on a subject: taken off
        // the queue and never handed on (cameOnSubject).
        if (!cameOnSubject(m)) {
          try {
            c.ack(m);
          } catch {
            /* the channel went; it comes again and is dropped then */
          }
          return;
        }
        const replyTo = m.properties?.replyTo as string | undefined;
        const correlationId = m.properties?.correlationId as string | undefined;
        const reply = replyTo ? (correlationId ? `${replyTo}#${correlationId}` : replyTo) : undefined;
        inbox.items.push({
          subject: m.fields.routingKey,
          reply,
          respond: (d?: Uint8Array) => {
            if (!reply) return false;
            this.respondTo(reply, d);
            return true;
          },
          backlog: early || m.fields?.redelivered === true,
          data: new Uint8Array(m.content.buffer, m.content.byteOffset, m.content.byteLength),
          ack: () => {
            if (settled) return;
            settled = true;
            try {
              c.ack(m);
            } catch {
              /* the channel went; it comes again */
            }
          },
          nak: (delayMs?: number) => {
            if (settled) return;
            settled = true;
            const back = () => {
              try {
                c.nack(m, false, true);
              } catch {
                /* the channel went; it comes again */
              }
            };
            if (delayMs && delayMs > 0) setTimeout(back, delayMs);
            else back();
          },
        });
        inbox.wake?.();
      });
      ch = c;
    };
    const entry = { restore: open };
    await this.enqueue(open);
    this.consumers.add(entry);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      this.consumers.delete(entry);
      inbox.ended = true;
      inbox.wake?.();
      void ch?.close().catch(() => undefined);
    };
    return {
      stop,
      bind: async (pattern: string) => {
        if (bindings.has(pattern)) return;
        bindings.add(pattern);
        await this.enqueue(async () => {
          const c = await this.channel();
          try {
            await c.bindQueue(queue, MESH_EXCHANGE, bindingKey(pattern));
          } finally {
            await c.close().catch(() => undefined);
          }
        });
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (inbox.items.length) {
            yield inbox.items.shift()!;
            continue;
          }
          if (inbox.ended) return;
          await new Promise<void>((r) => (inbox.wake = r));
          inbox.wake = null;
        }
      },
    };
  }

  /** Wait until everything asked for so far has gone out. */
  async flush(): Promise<void> {
    await this.enqueue(async () => undefined);
  }

  async drain(): Promise<void> {
    await this.flush().catch(() => undefined);
    await this.close();
  }

  async close(): Promise<void> {
    this.closedFlag = true;
    for (const s of this.subs) s.queue?.end();
    this.subs.clear();
    const c = this.conn;
    this.conn = null;
    await c?.close().catch(() => undefined);
  }

  get isClosed(): boolean {
    return this.closedFlag || (this.conn === null && !this.reconnecting);
  }

  /** Events as NATS reports them on its status iterator: here, a refused
   *  operation (`type: "error"`, "Permissions Violation: …"), and the
   *  connection's end. One iterator per call, until the connection closes. */
  status(): AsyncIterable<{ type: string; data?: unknown; error?: unknown }> {
    const items: { type: string; data?: unknown; error?: unknown }[] = [];
    let wake: (() => void) | null = null;
    const q = { push: (e: { type: string; data?: unknown; error?: unknown }) => { items.push(e); wake?.(); } };
    this.statusQueues.add(q);
    const self = this;
    return (async function* () {
      try {
        for (;;) {
          if (items.length) {
            yield items.shift()!;
            continue;
          }
          if (self.closedFlag) return;
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 500);
          });
          wake = null;
        }
      } finally {
        self.statusQueues.delete(q);
      }
    })();
  }

  onReconnect(cb: () => void): () => void {
    this.reconnectCbs.add(cb);
    return () => {
      this.reconnectCbs.delete(cb);
    };
  }

  get maxPayload(): number {
    return AMQP_MAX_PAYLOAD;
  }

  /** Bytes for a publish, from a string or bytes. */
  static bytes(x: string | Uint8Array): Uint8Array {
    return typeof x === "string" ? te.encode(x) : x;
  }
}
