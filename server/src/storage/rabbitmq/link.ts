/**
 * One AMQP 0-9-1 connection to RabbitMQ, kept up (step 9 of
 * docs/agent-messaging-server-plan.md).
 *
 * NATS clients reconnect on their own and carry their subscriptions across;
 * an AMQP connection does neither, so this does it: when the connection drops
 * it connects again, with a growing pause, for up to `reconnectForMs`, and
 * then calls everyone who asked (`onReconnect`) to put back their channels,
 * queues and consumers. If it cannot get back in that time it gives up and
 * `closed()` settles, which ends the server so its supervisor starts it
 * again, as a NATS connection that runs out of reconnect attempts does.
 */
import amqp, { type Channel, type ChannelModel } from "amqplib";

export interface LinkSettings {
  /** amqp://user:password@host:port/vhost */
  url: string;
  /** The connection's name, shown in RabbitMQ's management views. */
  name: string;
  /** How long to keep trying after the connection drops. */
  reconnectForMs?: number;
  /** The heartbeat interval, in seconds. */
  heartbeat?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AmqpLink {
  private conn: ChannelModel | null = null;
  private readonly reconnectCbs = new Set<() => Promise<void> | void>();
  private closing = false;
  private gaveUp = false;
  private resolveClosed!: () => void;
  private readonly closedP = new Promise<void>((r) => (this.resolveClosed = r));
  private waiters: (() => void)[] = [];

  constructor(private readonly settings: LinkSettings) {}

  /** Connect the first time. Throws when the broker cannot be reached or
   *  refuses the credential. */
  async open(): Promise<void> {
    await this.connectOnce();
  }

  private async connectOnce(): Promise<ChannelModel> {
    const url = new URL(this.settings.url);
    if (!url.searchParams.has("heartbeat")) url.searchParams.set("heartbeat", String(this.settings.heartbeat ?? 20));
    const conn = await amqp.connect(url.toString(), {
      clientProperties: { connection_name: this.settings.name },
    });
    conn.on("error", (err: Error) => {
      // A connection error is followed by 'close', which does the work.
      console.error(`[amqp] ${this.settings.name}: connection error: ${err.message}`);
    });
    conn.on("close", () => {
      if (this.conn !== conn) return;
      this.conn = null;
      if (this.closing) {
        this.resolveClosed();
        return;
      }
      console.error(`[amqp] ${this.settings.name}: connection lost; connecting again`);
      void this.recover();
    });
    this.conn = conn;
    if (!this.restoring) for (const w of this.waiters.splice(0)) w();
    return conn;
  }

  /** True while the reconnect callbacks put things back: everyone else waits,
   *  so nothing is published before the subscriptions it may need exist. */
  private restoring = false;

  private async recover(): Promise<void> {
    const until = Date.now() + (this.settings.reconnectForMs ?? 120_000);
    let pause = 500;
    while (!this.closing) {
      try {
        this.restoring = true;
        await this.connectOnce();
        console.log(`[amqp] ${this.settings.name}: connected again`);
        for (const cb of [...this.reconnectCbs]) {
          try {
            await cb();
          } catch (err) {
            console.error(`[amqp] ${this.settings.name}: could not restore after reconnecting:`, err instanceof Error ? err.message : err);
          }
        }
        this.restoring = false;
        for (const w of this.waiters.splice(0)) w();
        return;
      } catch (err) {
        this.restoring = false;
        if (Date.now() + pause > until) {
          console.error(`[amqp] ${this.settings.name}: gave up reconnecting: ${err instanceof Error ? err.message : err}`);
          this.gaveUp = true;
          for (const w of this.waiters.splice(0)) w();
          this.resolveClosed();
          return;
        }
        await sleep(pause);
        pause = Math.min(pause * 2, 5000);
      }
    }
  }

  /** The connection, waiting for it while it is being put back. `restoring`
   *  is for the reconnect callbacks, which run before anyone else may. */
  async connection(restoring = false): Promise<ChannelModel> {
    for (;;) {
      if (this.conn && (restoring || !this.restoring)) return this.conn;
      if (this.closing || this.gaveUp) throw new Error(`the connection to the broker is closed (${this.settings.name})`);
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  /** A new channel on the current connection. */
  async channel(restoring = false): Promise<Channel> {
    const conn = await this.connection(restoring);
    const ch = await conn.createChannel();
    // A channel error (a refused bind, a missing queue) closes that channel
    // only; whoever owns it sees the close.
    ch.on("error", () => undefined);
    return ch;
  }

  /** Called after the connection is back, to put back what it carried. */
  onReconnect(cb: () => Promise<void> | void): () => void {
    this.reconnectCbs.add(cb);
    return () => {
      this.reconnectCbs.delete(cb);
    };
  }

  isOpen(): boolean {
    return this.conn !== null;
  }

  async close(): Promise<void> {
    this.closing = true;
    const c = this.conn;
    if (c) {
      await c.close().catch(() => undefined);
    } else {
      this.resolveClosed();
    }
    for (const w of this.waiters.splice(0)) w();
  }

  closed(): Promise<void> {
    return this.closedP;
  }
}
