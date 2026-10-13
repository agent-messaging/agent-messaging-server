import type { BusMessage } from "../storage/index.js";
import type { Envelope } from "../sdk.js";
import { createEnvelope, encode, decode, childSpan, ErrorCode, signEnvelope } from "../sdk.js";
import { RateLimiter } from "./rate-limiter.js";
import { tenantRateCheck } from "./tenant-rate.js";

/** Anything that can sign on behalf of a service identity (an nkey keypair). */
export interface Signer {
  getPublicKey(): string;
  sign(data: Uint8Array): Uint8Array;
}

/**
 * A service identity. Pass a **Signer** (nkey keypair) so the service signs its
 * outbound envelopes (§4.5) — required for 0.2 agents to accept its replies.
 * A plain string is a legacy, *unsigned* identity (auxiliary/retiring services
 * only).
 */
export type ServiceIdentity = string | Signer;

function isSigner(id: ServiceIdentity): id is Signer {
  return typeof id !== "string" && typeof (id as Signer).getPublicKey === "function";
}

/** The public `from` value for a service identity. */
export function idOf(id: ServiceIdentity): string {
  return isSigner(id) ? id.getPublicKey() : id;
}

/** Sign (if the identity is a keypair) and encode an envelope for the wire. */
export function sealEnvelope(env: Envelope, id: ServiceIdentity): Uint8Array {
  if (isSigner(id)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signEnvelope(env, id as any);
  }
  return encode(env);
}

/** Default: 60 requests per 60-second window per sender. */
const NATS_RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_NATS_MAX ?? "60", 10);
const NATS_RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_NATS_WINDOW_MS ?? "60000", 10);

/** Shared rate limiter instance for all NATS subject handlers. */
export const natsRateLimiter = new RateLimiter(NATS_RATE_LIMIT_MAX, NATS_RATE_LIMIT_WINDOW_MS);

/** Ed25519 user nkey, public half: 56 base32 characters after the `U` prefix.
 *  Same shape the rooms service validates member ids against. */
const NKEY_PUBLIC = /^U[A-Z2-7]{55}$/;

/**
 * The key of the CONNECTION a message arrived on — as much of it as this
 * transport exposes.
 *
 * Core NATS hands a subscriber the subject, the reply subject, the payload and
 * headers, and **nothing about the publisher's authenticated user** (`Msg`, and so `BusMessage`, has
 * no such field, and header values are publisher-supplied). So a service
 * cannot read the connection's user key off a message. The one signal the
 * BROKER can pin to a credential is the SUBJECT: a user JWT minted with
 * `allow_pub: "<base>.<that user's own key>"` cannot publish under anybody
 * else's token, so on such a channel the trailing token IS the connection's
 * key. That is the whole mechanism, and its strength is entirely the
 * credential's: on the un-tokenized base subject there is no connection
 * identity to be had, and on a tokenized subject reached by a credential that
 * was NOT minted with the template the token is just another claim.
 *
 * Returns the token only for `"<base>.<nkey>"` exactly — never for a deeper
 * subject, and never for base subjects whose trailing token is somebody
 * else's id (`mesh.registry.get.<agent>`).
 */
export function boundKeyOf(msg: Pick<BusMessage, "subject"> | undefined, base: string): string | null {
  if (!msg?.subject.startsWith(`${base}.`)) return null;
  const token = msg.subject.slice(base.length + 1);
  return NKEY_PUBLIC.test(token) ? token : null;
}

/** Coarser second window for the connection-bound key, where one exists.
 *  Generous on purpose: one credential legitimately fronts many agents. */
const NATS_CONN_RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_NATS_CONN_MAX ?? "600", 10);

/**
 * Second limiter, keyed on the connection rather than the envelope sender.
 *
 * The per-sender window below is keyed on `reqEnv.from`, a freely minted nkey
 * that costs nothing to rotate — so as fair-use shaping it works and as an
 * abuse limit it is evadable by generating a new key per request. The stable
 * identity is the credential, and the only layer that sees one is the
 * transport. This limiter meters the one case where the broker does pin it
 * into the subject (see `boundKeyOf`).
 *
 * RESIDUAL, stated plainly: on every subject that carries no bound token —
 * which today is all of them, since no credential is yet minted with the
 * template — this limiter never fires and per-sender shaping is the only
 * backstop. The real fix is per-user JWT limits at the broker, which is the
 * only place a connection cannot rotate away from its own identity.
 */
export const natsConnRateLimiter = new RateLimiter(NATS_CONN_RATE_LIMIT_MAX, NATS_RATE_LIMIT_WINDOW_MS);

/**
 * A request-reply handler function.
 * Takes a decoded envelope and the raw NATS message, returns a response envelope
 * — or `null` to answer nothing at all. Silence is a real answer on the
 * admission control subjects (EXT-6), where a client reads ANY reply as an ack.
 */
export type HandlerFn = (envelope: Envelope, msg: BusMessage) => Promise<Envelope | null>;

/** Extracts the connection-bound key for a message, when the subject carries
 *  one (see `boundKeyOf`). Supplied per-subscription, because only the caller
 *  knows whether its subject's trailing token is the publisher's own key. */
export type BoundKeyFn = (msg: BusMessage) => string | null;

/**
 * Wraps a handler with envelope decode/encode, rate limiting, and error handling.
 * Returns a function suitable for NATS subscription message processing.
 */
export function wrapHandler(
  serviceId: ServiceIdentity,
  handler: HandlerFn,
  limiter?: RateLimiter,
  boundKey?: BoundKeyFn,
) {
  const rl = limiter ?? natsRateLimiter;

  return async (msg: BusMessage): Promise<void> => {
    let reqEnv: Envelope;
    try {
      reqEnv = decode(msg.data);
    } catch (err) {
      if (msg.reply) {
        // A signature that is missing or does not verify against `from` is
        // the sender not being who it says (SPEC: IDENTITY_MISMATCH), and the
        // caller is told so; anything else that will not decode is a
        // malformed envelope.
        const forged = (err as { code?: unknown })?.code === ErrorCode.IDENTITY_MISMATCH;
        const errEnv = createEnvelope({
          type: "respond",
          from: idOf(serviceId),
          error: {
            code: forged ? ErrorCode.IDENTITY_MISMATCH : ErrorCode.INVALID_ENVELOPE,
            message: forged ? (err as Error).message : "Failed to decode envelope",
            retryable: false,
          },
        });
        msg.respond(sealEnvelope(errEnv, serviceId));
      }
      return;
    }

    // Rate limit check: keyed by sender, then by the connection wherever the
    // subject pins one — a rotating sender key evades the first, not the second.
    const conn = boundKey?.(msg) ?? null;
    for (const [limiter, key] of [
      [rl, reqEnv.from] as const,
      [natsConnRateLimiter, conn ? `conn:${conn}` : null] as const,
    ]) {
      if (!key) continue;
      const result = limiter.check(key);
      if (!result.allowed) {
        if (msg.reply) {
          const errEnv = createEnvelope({
            type: "respond",
            from: idOf(serviceId),
            to: reqEnv.from,
            in_reply_to: reqEnv.id,
            trace: childSpan(reqEnv.trace),
            error: {
              code: ErrorCode.RATE_LIMITED,
              message: `Rate limit exceeded. Try again in ${result.retryAfterMs}ms.`,
              retryable: true,
              retry_after_ms: result.retryAfterMs,
            },
          });
          msg.respond(sealEnvelope(errEnv, serviceId));
        }
        return;
      }
    }

    // The sender's tenant's rate cap, when its tenant has one
    // (keychain/tenant-limits.ts). Shared by every agent of the tenant.
    const tenantCap = tenantRateCheck();
    if (tenantCap && reqEnv.from) {
      const r = await tenantCap(reqEnv.from).catch(() => null);
      if (r && !r.allowed) {
        if (msg.reply) {
          const errEnv = createEnvelope({
            type: "respond",
            from: idOf(serviceId),
            to: reqEnv.from,
            in_reply_to: reqEnv.id,
            trace: childSpan(reqEnv.trace),
            error: {
              code: ErrorCode.RATE_LIMITED,
              message: `This agent's tenant is over its limit of ${r.limit} requests a minute to this mesh's services. Try again in ${r.retryAfterMs}ms.`,
              retryable: true,
              retry_after_ms: r.retryAfterMs,
            },
          });
          msg.respond(sealEnvelope(errEnv, serviceId));
        }
        return;
      }
    }

    try {
      const respEnv = await handler(reqEnv, msg);
      if (respEnv && msg.reply) {
        msg.respond(sealEnvelope(respEnv, serviceId));
      }
    } catch (err) {
      if (msg.reply) {
        const errEnv = createEnvelope({
          type: "respond",
          from: idOf(serviceId),
          to: reqEnv.from,
          in_reply_to: reqEnv.id,
          trace: childSpan(reqEnv.trace),
          error: {
            code: ErrorCode.INTERNAL_ERROR,
            message: err instanceof Error ? err.message : "Internal error",
            retryable: true,
          },
        });
        msg.respond(sealEnvelope(errEnv, serviceId));
      }
    }
  };
}

/** The slice of a NATS connection this helper needs. `queue` is part of the
 *  shape so that a caller CAN ask for one; see `subscribeWithHandler`. */
export interface SubscribeCapable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribe: (subject: string, opts?: { queue?: string }) => any;
}

/**
 * Helper to subscribe with request-reply handler pattern using async iterator.
 *
 * ## `queue`
 *
 * A NATS queue group is what makes a second instance of a service POSSIBLE.
 * Core NATS delivers a published message to every matching subscriber, so two
 * instances subscribed to the same request subject each receive every request,
 * each run the handler, and each publish a reply to the requester's reply
 * subject. The requester takes the first answer and discards the rest, so the
 * duplication is invisible from outside while every request is served twice —
 * charged twice, rate-limited twice, and for anything that writes, applied
 * twice. Members of a queue group are instead treated as one logical
 * subscriber: the server picks exactly one of them per message. So a service
 * subject has to carry a queue name BEFORE a second instance of that service
 * can be started, not after.
 *
 * Until this parameter existed the connection type here admitted no options at
 * all, so no caller could have passed one. Nothing passes one yet — this only
 * removes the impossibility. When `queue` is omitted the underlying call is
 * `nc.subscribe(subject)` with no options argument, exactly as before.
 */
export function subscribeWithHandler(
  nc: SubscribeCapable,
  subject: string,
  serviceId: ServiceIdentity,
  handler: HandlerFn,
  limiter?: RateLimiter,
  boundKey?: BoundKeyFn,
  queue?: string,
) {
  const sub = queue ? nc.subscribe(subject, { queue }) : nc.subscribe(subject);
  const wrapped = wrapHandler(serviceId, handler, limiter, boundKey);

  (async () => {
    for await (const msg of sub) {
      wrapped(msg).catch((err) => {
        console.error(`[${subject}] unhandled error:`, err);
      });
    }
  })();

  return sub;
}
