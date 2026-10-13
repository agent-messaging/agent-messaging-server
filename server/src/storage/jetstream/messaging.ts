/**
 * The messaging interface on NATS: core NATS publish, subscribe and
 * request-reply on the connection the core has always been given. Each method
 * makes the call the services made before, with the same arguments (an option
 * nobody gave is not passed), so nothing changes on the wire.
 */
import { createInbox, headers, type NatsConnection, type PublishOptions as NatsPublishOptions } from "nats";
import type { BusMessage, BusSubscription, Messaging, PublishOptions, RequestOptions, SubscribeOptions } from "../types.js";

export const MESSAGING = Symbol.for("agent-messaging.messaging");

export function isMessaging(x: unknown): x is Messaging {
  return typeof x === "object" && x !== null && (x as { [MESSAGING]?: boolean })[MESSAGING] === true;
}

export class NatsMessaging implements Messaging {
  readonly [MESSAGING] = true;

  constructor(readonly nc: NatsConnection) {}

  publish(subject: string, data?: Uint8Array, opts?: PublishOptions): void {
    if (opts === undefined) {
      if (data === undefined) this.nc.publish(subject);
      else this.nc.publish(subject, data);
      return;
    }
    const o: Partial<NatsPublishOptions> = {};
    if (opts.reply !== undefined) o.reply = opts.reply;
    if (opts.msgId !== undefined) {
      const h = headers();
      h.set("Nats-Msg-Id", opts.msgId);
      o.headers = h;
    }
    this.nc.publish(subject, data, o);
  }

  subscribe(subject: string, opts?: SubscribeOptions): BusSubscription {
    return (opts === undefined ? this.nc.subscribe(subject) : this.nc.subscribe(subject, opts)) as unknown as BusSubscription;
  }

  request(subject: string, data: Uint8Array, opts: RequestOptions): Promise<BusMessage> {
    // `live` is already what a core NATS request is; it is not passed on.
    if (opts.live === undefined) return this.nc.request(subject, data, opts) as Promise<BusMessage>;
    const { live: _live, ...rest } = opts;
    return this.nc.request(subject, data, rest) as Promise<BusMessage>;
  }

  newInbox(): string {
    return createInbox();
  }
}
