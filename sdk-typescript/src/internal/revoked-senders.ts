/**
 * Refusing a revoked sender (SPEC §5.3): "Receivers MUST refuse a message
 * signed by a revoked agent key."
 *
 * An envelope signature proves which key signed it, not that the key is still
 * its owner's. When an owner reports a key leaked, the registry marks it
 * revoked, and from then on it answers a `get` for that key with
 * `UNAUTHORIZED`, `details.reason: agent_key_revoked`. This asks that question
 * about each sender before its message is handled, with a short memo.
 *
 * FAIL SAFE, in both directions, as the plan required:
 *
 *   - a check that cannot answer (registry down, slow, no responders) does not
 *     block anyone: a known-good contact keeps working through a registry
 *     outage;
 *   - a key already seen revoked stays refused for the life of the process,
 *     whatever the registry says or fails to say later, because revocation is
 *     permanent.
 *
 * "Not revoked" answers are kept for OK_MS, so a revocation reaches a receiver
 * that already knows the sender within that. Failed lookups are kept for
 * FAILED_MS so an outage does not add a timeout to every message.
 */

export type RevocationAnswer =
  | { revoked: true; revokedAt?: string; replacedBy?: string }
  | { revoked: false; paused?: boolean; since?: string }
  | { unknown: true };

export interface RevokedSender {
  revokedAt?: string;
  replacedBy?: string;
  /** The kill switch: the sender is PAUSED, not revoked. A pause is lifted,
   *  so it is remembered for OK_MS only, never for the life of the process. */
  paused?: boolean;
  since?: string;
}

export class RevokedSenders {
  static readonly OK_MS = 60_000;
  static readonly FAILED_MS = 15_000;
  static readonly LOOKUP_TIMEOUT_MS = 2_000;
  private static readonly MAX = 5_000;

  private revoked = new Map<string, RevokedSender>();
  private notRevoked = new Map<string, number>();
  private paused = new Map<string, { since?: string; until: number }>();
  private inFlight = new Map<string, Promise<RevokedSender | null>>();

  constructor(
    private lookup: (key: string) => Promise<RevocationAnswer>,
    private now: () => number = Date.now,
  ) {}

  /** The revocation for `key`, or null when it is not known to be revoked. */
  async check(key: string): Promise<RevokedSender | null> {
    const known = this.revoked.get(key);
    if (known) return known;
    const pause = this.paused.get(key);
    if (pause && pause.until > this.now()) return { paused: true, ...(pause.since ? { since: pause.since } : {}) };
    const until = this.notRevoked.get(key);
    if (until !== undefined && until > this.now()) return null;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const p = this.ask(key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  /** Record a revocation learned some other way (an answer to a request, a
   *  refusal the adapter saw). */
  remember(key: string, r: RevokedSender): void {
    this.revoked.set(key, r);
    this.notRevoked.delete(key);
  }

  private async ask(key: string): Promise<RevokedSender | null> {
    let answer: RevocationAnswer;
    try {
      answer = await Promise.race([
        this.lookup(key),
        new Promise<RevocationAnswer>((resolve) => {
          const t = setTimeout(() => resolve({ unknown: true }), RevokedSenders.LOOKUP_TIMEOUT_MS);
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
    } catch {
      answer = { unknown: true };
    }
    if ("revoked" in answer && answer.revoked) {
      const r: RevokedSender = { revokedAt: answer.revokedAt, replacedBy: answer.replacedBy };
      this.remember(key, r);
      return r;
    }
    if ("revoked" in answer && !answer.revoked && answer.paused) {
      if (this.paused.size > RevokedSenders.MAX) this.paused.clear();
      this.paused.set(key, { since: answer.since, until: this.now() + RevokedSenders.OK_MS });
      this.notRevoked.delete(key);
      return { paused: true, ...(answer.since ? { since: answer.since } : {}) };
    }
    this.paused.delete(key);
    if (this.notRevoked.size > RevokedSenders.MAX) this.notRevoked.clear();
    const ttl = "unknown" in answer ? RevokedSenders.FAILED_MS : RevokedSenders.OK_MS;
    this.notRevoked.set(key, this.now() + ttl);
    return null;
  }
}
