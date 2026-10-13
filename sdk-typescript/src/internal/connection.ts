import {
  connect as natsConnect,
  createInbox,
  headers as natsHeaders,
  type NatsConnection,
  type Msg,
  type Subscription,
  type Status,
  Events,
  ErrorCode as NatsErrorCode,
  NatsError,
} from "nats.ws";
import type { ConnectOptions } from "../types/options.js";
import { MeshError, ErrorCode } from "../types/errors.js";
import { bindingOfUrl } from "../transport.js";
import { dialWithRetry } from "./connect-retry.js";

export class ConnectionManager {
  /** The transport (docs/agent-messaging-server-plan.md, step 10): this is the
   *  NATS one; an `amqp://` address gets the AMQP one (amqp-connection.ts). */
  readonly binding: "nats" | "amqp" = "nats";
  private nc: NatsConnection;
  /** Callbacks to run when the transport reconnects, and whether the one status
   *  iterator that feeds them is running yet. */
  private reconnectCbs = new Set<() => void>();
  private watchingStatus = false;

  private constructor(nc: NatsConnection) {
    this.nc = nc;
  }

  static async connect(opts: ConnectOptions): Promise<ConnectionManager> {
    // A mesh on the RabbitMQ binding is dialled over AMQP. The address's
    // scheme says which (transport.ts); everything else is unchanged.
    const servers = Array.isArray(opts.servers) ? opts.servers : [opts.servers];
    if (servers.length && servers.every((s) => bindingOfUrl(s) === "amqp")) {
      const { AmqpConnection } = await import("./amqp-connection.js");
      return (await AmqpConnection.connect(opts)) as unknown as ConnectionManager;
    }
    try {
      // The first connection only: with `connectRetry`, a broker that is
      // busy or restarting is tried again (connect-retry.ts). Later drops are
      // the transport's own reconnect, unchanged.
      const nc = await dialWithRetry(() => natsConnect({
        servers: Array.isArray(opts.servers) ? opts.servers : [opts.servers],
        name: opts.name,
        maxReconnectAttempts: opts.maxReconnectAttempts ?? 10,
        reconnectTimeWait: opts.reconnectTimeWait ?? 2000,
        reconnect: opts.reconnect ?? true,
        authenticator: opts.authenticator,
        token: opts.auth?.token,
        user: opts.auth?.user,
        pass: opts.auth?.pass,
      }), opts.connectRetry);
      return new ConnectionManager(nc);
    } catch (err) {
      throw new MeshError(
        ErrorCode.TRANSPORT_TIMEOUT,
        `Failed to connect to NATS: ${(err as Error).message}`,
        { cause: err as Error },
      );
    }
  }

  /** Publish, optionally with NATS headers. Headers are plain string pairs
   *  rather than a nats.ws `MsgHdrs`, so callers (and test fakes) never touch
   *  the transport's header type; this seam converts. The caller today is
   *  `emit()`, whose `Nats-Msg-Id` (§18.8) lets any stream capturing the
   *  subject drop a duplicate publish inside its duplicate window. */
  publish(
    subject: string,
    data: Uint8Array,
    opts?: { headers?: Record<string, string> },
  ): void {
    if (opts?.headers) {
      const h = natsHeaders();
      for (const [name, value] of Object.entries(opts.headers)) h.set(name, value);
      this.nc.publish(subject, data, { headers: h });
      return;
    }
    this.nc.publish(subject, data);
  }

  async request(
    subject: string,
    data: Uint8Array,
    opts?: { timeout?: number },
  ): Promise<Msg> {
    try {
      return await this.nc.request(subject, data, {
        timeout: opts?.timeout ?? 5000,
      });
    } catch (err) {
      if (err instanceof NatsError) {
        if (err.code === NatsErrorCode.NoResponders) {
          throw new MeshError(
            ErrorCode.TRANSPORT_NO_RESPONDERS,
            `No responders on subject '${subject}'`,
            { cause: err },
          );
        }
        if (err.code === NatsErrorCode.Timeout) {
          throw new MeshError(
            ErrorCode.TRANSPORT_TIMEOUT,
            `Request timed out on subject '${subject}'`,
            { cause: err },
          );
        }
        if (err.isPermissionError?.()) {
          throw new MeshError(
            ErrorCode.TRANSPORT_PERMISSION_DENIED,
            `Permission denied on subject '${subject}'`,
            { cause: err },
          );
        }
      }
      throw err;
    }
  }

  /**
   * A request-reply that can receive MORE THAN ONE reply on its inbox — what
   * the §6.4a accept signal requires: the accept and the substantive respond
   * arrive on the same reply subject, and core `request()` unsubscribes after
   * the first. The caller classifies each inbound message:
   *
   *  - `"resolve"` — this is the substantive reply; complete with it.
   *  - `"ignore"` — not ours (raced garbage, a duplicate); keep waiting.
   *  - `"reset"` — an accept: keep waiting, and re-arm the timeout for a full
   *    `opts.timeout` from now (§6.4a "reset its response timeout").
   *  - `{ reject }` — a terminal non-answer (the §6.4a queued ack); fail with
   *    the given error.
   *
   * The server's no-responders signal (an empty message with header code 503,
   * negotiated at CONNECT) maps to TRANSPORT_NO_RESPONDERS exactly as
   * `request()` maps it. Test fakes that implement only `request()` never see
   * this method — callers feature-detect it, like `onReconnect`.
   */
  async requestMulti(
    subject: string,
    data: Uint8Array,
    opts: {
      timeout: number;
      classify: (msg: Msg) => "resolve" | "ignore" | "reset" | { reject: unknown };
      /** Receives a `stop()` that ends this wait early, tearing down the reply
       *  subscription and the timer. The §6.4 requester needs it: the reply
       *  subject is liveness-only there, so once the respond has arrived at the
       *  requester's inbox this watch has nothing left to learn and holding the
       *  subscription open for the rest of the timeout would leak one per
       *  request. Stopping REJECTS (there is no Msg to resolve with); the
       *  caller that asked to stop is expected to swallow that rejection. */
      onListen?: (stop: () => void) => void;
    },
  ): Promise<Msg> {
    const inbox = createInbox();
    return await new Promise<Msg>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let sub: Subscription | null = null;
      const finish = (err: unknown, msg?: Msg) => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        try {
          sub?.unsubscribe();
        } catch {
          /* already gone */
        }
        if (msg !== undefined) resolve(msg);
        else reject(err);
      };
      const onTimeout = () =>
        finish(
          new MeshError(
            ErrorCode.TRANSPORT_TIMEOUT,
            `Request timed out on subject '${subject}'`,
          ),
        );
      timer = setTimeout(onTimeout, opts.timeout);
      sub = this.nc.subscribe(inbox, {
        callback: (err, msg) => {
          if (done) return;
          if (err) {
            finish(err);
            return;
          }
          // The server's 503: nobody subscribes the subject we published to.
          if (msg.data.length === 0 && msg.headers?.code === 503) {
            finish(
              new MeshError(
                ErrorCode.TRANSPORT_NO_RESPONDERS,
                `No responders on subject '${subject}'`,
              ),
            );
            return;
          }
          let verdict: "resolve" | "ignore" | "reset" | { reject: unknown };
          try {
            verdict = opts.classify(msg);
          } catch (classifyErr) {
            finish(classifyErr);
            return;
          }
          if (verdict === "resolve") {
            finish(undefined, msg);
          } else if (verdict === "reset") {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(onTimeout, opts.timeout);
          } else if (typeof verdict === "object") {
            finish(verdict.reject);
          }
          // "ignore": keep waiting.
        },
      });
      opts.onListen?.(() =>
        finish(
          new MeshError(
            ErrorCode.TRANSPORT_TIMEOUT,
            `Reply-subject watch on '${subject}' was stopped by its caller`,
          ),
        ),
      );
      try {
        this.nc.publish(subject, data, { reply: inbox });
      } catch (pubErr) {
        finish(pubErr);
      }
    });
  }

  subscribe(subject: string, handler: (msg: Msg) => void): Subscription {
    const sub = this.nc.subscribe(subject);

    (async () => {
      for await (const msg of sub) {
        try {
          handler(msg);
        } catch {
          // Handler errors should not crash the subscription
        }
      }
    })();

    return sub;
  }

  /** Wait until the server has everything sent so far, subscriptions included:
   *  a subscription opened before this call is live when it returns. The AMQP
   *  transport has the same method (its queue binds in order). */
  async flush(): Promise<void> {
    await this.nc.flush();
  }

  async drain(): Promise<void> {
    await this.nc.drain();
  }

  async close(): Promise<void> {
    await this.nc.close();
  }

  get isClosed(): boolean {
    return this.nc.isClosed();
  }

  status(): AsyncIterable<Status> {
    return this.nc.status();
  }

  /**
   * Run `cb` every time the transport reconnects. Returns an unsubscribe.
   *
   * nats.ws reports reconnects on the `status()` iterator (`Events.Reconnect`),
   * which is the client's own event channel — nothing here polls
   * `isClosed`/connection state, and nothing here needs to: a poll would learn
   * "connected" long after the gap it is supposed to react to, and a gap is
   * exactly when a subscriber missed messages.
   *
   * One iterator for every caller, deliberately. `nc.status()` mints a FRESH
   * queued iterator per call and pushes it onto the protocol's listener list
   * without ever removing it, so a node hosting many short-lived agents would
   * accumulate one listener per agent for the life of the connection. Callers
   * share this one and drop their callback instead.
   */
  onReconnect(cb: () => void): () => void {
    this.reconnectCbs.add(cb);
    if (!this.watchingStatus) {
      this.watchingStatus = true;
      void (async () => {
        try {
          for await (const s of this.nc.status()) {
            if (s.type !== Events.Reconnect) continue;
            // A throwing callback must not end the watch for everybody else.
            for (const fn of [...this.reconnectCbs]) {
              try {
                fn();
              } catch {
                /* the callback's problem, not the watch's */
              }
            }
          }
        } catch {
          // The iterator ends when the connection closes; nothing to report.
        } finally {
          this.watchingStatus = false;
        }
      })();
    }
    return () => {
      this.reconnectCbs.delete(cb);
    };
  }

  /** The transport's advertised maximum payload in bytes (§18.9), or
   *  undefined when the server has not (yet) said. The §6.4b envelope-size
   *  pre-flight compares against this. */
  get maxPayload(): number | undefined {
    const mp = this.nc.info?.max_payload;
    return typeof mp === "number" && mp > 0 ? mp : undefined;
  }

  get raw(): NatsConnection {
    return this.nc;
  }
}
