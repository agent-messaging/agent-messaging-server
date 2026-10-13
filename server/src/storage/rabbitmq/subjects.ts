/**
 * Subjects on RabbitMQ (step 9 of docs/agent-messaging-server-plan.md).
 *
 * A subject is published as the routing key on the mesh's topic exchange,
 * unchanged: both are dot-separated words. A subscription's pattern becomes a
 * binding key:
 *
 *   `*`  matches one word in both, so it is written as it is;
 *   `>`  (SPEC §14.2: one or more words) becomes `*.#`. AMQP's `#` alone
 *        matches zero or more words, so `mesh.event.#` would also take a
 *        message published on `mesh.event` itself, which `mesh.event.>` does
 *        not. `*` then `#` is one word and then any number: exactly `>`.
 *
 * Every delivery is checked against the subscription's pattern before it is
 * handed on (`subjectMatches`), so a message that reached a queue some other
 * way (published straight to the queue through the default exchange) never
 * reaches a subscriber as though it came on a subject.
 */

/** The topic exchange every subject is published on. */
export const MESH_EXCHANGE = "mesh";

/** A subscription pattern as an AMQP binding key. */
export function bindingKey(pattern: string): string {
  const tokens = pattern.split(".");
  return tokens
    .map((t, i) => {
      if (t === ">") {
        if (i !== tokens.length - 1) throw new Error(`'>' must be the last token of a subject pattern: ${pattern}`);
        return "*.#";
      }
      return t;
    })
    .join(".");
}

/** A binding key written by `bindingKey`, read back as a subject pattern. */
export function patternOfBindingKey(key: string): string {
  if (key === "*.#") return ">";
  return key.endsWith(".*.#") ? `${key.slice(0, -4)}.>` : key;
}

/** Whether `subject` (no wildcards) matches `pattern` (§14.2). */
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

/**
 * Whether every subject `inner` can match is also matched by `outer`: the
 * test a permission needs, where `inner` is what a node asks to subscribe to
 * and `outer` is a pattern its credential allows.
 */
export function patternCovers(outer: string, inner: string): boolean {
  const o = outer.split(".");
  const n = inner.split(".");
  for (let i = 0; i < o.length; i++) {
    const t = o[i]!;
    if (t === ">") return n.length > i;
    if (i >= n.length) return false;
    const u = n[i]!;
    if (u === ">") return false; // inner reaches further than one token here
    if (t === "*") continue;
    if (u === "*" || u !== t) return false;
  }
  return o.length === n.length;
}

/** Whether some subject matches both patterns. */
export function patternsOverlap(a: string, b: string): boolean {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; ; i++) {
    const s = x[i];
    const t = y[i];
    if (s === undefined && t === undefined) return true;
    // `>` takes one or more tokens, and the other side has at least one here.
    if (s === ">") return t !== undefined;
    if (t === ">") return s !== undefined;
    if (s === undefined || t === undefined) return false;
    if (s !== "*" && t !== "*" && s !== t) return false;
  }
}

/** The reply address of a request answered through RabbitMQ's direct
 *  reply-to. A message's reply address is written `<reply-to>#<correlation
 *  id>` inside the binding, so a service that passes it along unchanged (the
 *  admission relay) hands on both halves. */
export const DIRECT_REPLY = "amq.rabbitmq.reply-to";

/** The per-message expiration of a live request: a queue that cannot hand it
 *  to a consumer at once drops it (RabbitMQ's TTL of zero). */
export const LIVE_EXPIRATION = "0";

export function joinReply(replyTo: string | undefined, correlationId: string | undefined): string | undefined {
  if (!replyTo) return undefined;
  return correlationId ? `${replyTo}#${correlationId}` : replyTo;
}

export function splitReply(reply: string): { replyTo: string; correlationId?: string } {
  const i = reply.indexOf("#");
  if (i < 0 || !reply.startsWith(DIRECT_REPLY)) return { replyTo: reply };
  return { replyTo: reply.slice(0, i), correlationId: reply.slice(i + 1) };
}
