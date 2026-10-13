/**
 * Per-agent inbox buffer (SPEC §16.4, DESIGN-OFFLINE-DELIVERY.md): a bounded
 * JetStream stream capturing one agent's inbox subject, so messages sent
 * while the agent is offline wait for it — "held up to 7 days or 25 MB"
 * (agentmesh.ai/plans.html).
 *
 * The node remains the durable endpoint; this is a convenience buffer:
 * R1, discard-old, deleted whenever the registration it serves goes away.
 * Sandbox agents get no buffer (their contract is live-only, and a
 * no-signup credential must not park megabytes on the broker).
 *
 * Capture works even when core NATS reports no-responders to the sender:
 * stream capture and core request-reply do not interact, so the live fast
 * path is untouched and senders need no cooperation.
 */

import { storageOf, type StorageLike, type StreamFamily, type StreamState } from "../storage/index.js";

const MAX_AGE_MS = Number(process.env.INBOX_BUFFER_MAX_AGE_MS ?? 7 * 24 * 3600_000);
const MAX_BYTES = Number(process.env.INBOX_BUFFER_MAX_BYTES ?? 25 * 1024 * 1024);
const DISABLED = process.env.INBOX_BUFFER_DISABLED === "1";
/** Ceiling on how many mailboxes exist at once. Registration identity is free —
 *  a fresh keypair costs nothing and the registry cannot bind one to a
 *  connection (§4.4 (b), see handlers/register.ts) — so without a ceiling each
 *  new key mints another file stream. What this bounds is STREAM COUNT: file
 *  handles, JetStream metadata, and how fast one key-rotating caller can consume
 *  both. It is not a disk bound (500 × 25 MB nominally exceeds the 10 GB the
 *  reference deployment gives JetStream, so the server's own `max_file` still
 *  binds first). Set it above the mailboxes a deployment legitimately has —
 *  past the ceiling, new agents are live-only. It bounds the blast radius of
 *  unbindable identity; it does not fix it. */
const MAX_MAILBOXES = Number(process.env.INBOX_BUFFER_MAX_MAILBOXES ?? 500);

/** Whether a held message is the platform's lifecycle request
 *  (`agentmesh-lifecycle/v1`, announcer.ts sendLifecycle) rather than mail. */
const LIFECYCLE_MARK = new TextEncoder().encode("agentmesh-lifecycle/v1");
export function isLifecycle(data: Uint8Array): boolean {
  outer: for (let i = 0; i + LIFECYCLE_MARK.length <= data.length; i++) {
    for (let j = 0; j < LIFECYCLE_MARK.length; j++) if (data[i + j] !== LIFECYCLE_MARK[j]) continue outer;
    return true;
  }
  return false;
}

/** Stream name for an agent's buffer. Agent ids are base32 nkeys (A–Z, 2–7),
 *  which are valid stream-name characters as-is. */
export function inboxStreamName(agentId: string): string {
  return `MESH_INBOX_${agentId}`;
}

/**
 * Whether an agent's inbox is guarded (EXT-6) — with `"unknown"` as a first-class
 * third answer.
 *
 * `false` and `"unknown"` are NOT the same and must never collapse into each
 * other: the only safe response to a guard lookup that FAILED is to leave the
 * mailbox alone, while `false` licenses re-pointing it at the raw inbox. A
 * `catch { return false }` around the lookup made a transient KV read error
 * indistinguishable from "this agent is not guarded", so a guarded agent's
 * mailbox could be re-pointed at unfiltered traffic and logged as a routine heal.
 */
export type GuardState = boolean | "unknown";

/** Resolves whether an agent's inbox is currently guarded (EXT-6). Injected so
 *  the buffer can inherit guard state without depending on the admission
 *  service; absent = the same as `"unknown"`, since with no resolver there is no
 *  telling an unguarded agent from an unasked question. */
export type GuardStateFn = (agentId: string) => Promise<GuardState>;

/** Deletes an agent's guard entry (EXT-6). Injected the same way and for the same
 *  reason as `GuardStateFn`: the registry holds the bucket, but deregister and
 *  the reaper need exactly one verb on it, so they get that verb and not the
 *  bucket. A guard entry must never outlive the registration it protects — an
 *  un-revoked entry has the mesh relay an agent's mail to a private subject
 *  nobody listens on, and claim a filter is running when it is not. */
export type ClearGuardFn = (agentId: string) => Promise<void>;

export class InboxBuffer {
  /** Live mailbox count: counted once from the server, then tracked here. */
  private mailboxes: number | null = null;
  /**
   * Every agent's mailbox (storage layer, family `MESH_INBOX_<agent>`).
   *
   * Opened HERE, in the constructor, rather than inside `ensure()`: opening it
   * reads the replica count (`MESH_JS_REPLICAS`, default 1), and `ensure()`
   * must never fail a registration and so catches everything, which would turn
   * a bad `MESH_JS_REPLICAS` into one swallowed line per registration and a
   * mesh where nobody has a mailbox. Here it runs when the registry constructs
   * the buffer, at boot, where the throw is the whole point.
   */
  private readonly boxes: StreamFamily;

  constructor(
    storage: StorageLike,
    private guardState?: GuardStateFn,
  ) {
    this.boxes = storageOf(storage).streams("MESH_INBOX_<agent>");
  }

  /** Current mailbox count, or null when the server could not be asked (in
   *  which case the cap must not block a legitimate registration). */
  private async count(): Promise<number | null> {
    if (this.mailboxes !== null) return this.mailboxes;
    try {
      let n = 0;
      for await (const _ of this.boxes.list()) n++;
      this.mailboxes = n;
      return n;
    } catch {
      return null;
    }
  }

  /** Idempotent: create the agent's buffer if it doesn't exist. Never throws —
   *  registration must not fail because the buffer tier is down. */
  async ensure(agentId: string): Promise<void> {
    if (DISABLED) return;
    const name = inboxStreamName(agentId);
    const raw = `mesh.agent.${agentId}.inbox`;
    try {
      const box = this.boxes.member(agentId);
      // A (re)created mailbox must inherit the guard state admission still
      // believes is in force. This is the c07 defect — a mailbox capturing the
      // RAW inbox while admission thinks the capture is filtered, so the offline
      // drain replays exactly the traffic admission dropped — reappearing by a
      // second path: deregister/reap deletes the stream, re-register recreates
      // it, and nothing points the new one at `.guarded`.
      const state: GuardState = this.guardState ? await this.guardState(agentId) : "unknown";
      const guarded = state === true;
      const want = guarded ? `${raw}.guarded` : raw;
      // Replicated by MESH_JS_REPLICAS on JetStream, default 1. An agent's
      // offline mail is the one thing here with no other copy anywhere: the
      // sender is gone and the agent has not read it yet, so a single-replica
      // mailbox on a lost node loses messages outright rather than merely
      // becoming unavailable.
      const spec = {
        subjects: [want],
        maxAgeMs: MAX_AGE_MS,
        maxBytes: MAX_BYTES,
        discard: "old" as const,
        // CRITICAL: a captured request must not be answered by the store. On
        // JetStream that is no_ack: without it JetStream answers every captured
        // request's reply subject with a {stream,seq} pub-ack — RACING the
        // agent's real reply on live request/reply traffic.
        silent: true,
      };
      let info: StreamState | null;
      try { info = await box.info(); } catch { info = null; }
      if (info) {
        // Exists: heal the two config fields that break correctness if wrong —
        // no_ack (streams created before the no_ack fix break live traffic) and
        // the capture subject (guard state drift, above). Other drift is
        // operator concern, not re-register concern.
        // Only re-point when guard state is actually KNOWN. `"unknown"` covers
        // both "no resolver wired up" and "the resolver's lookup failed", and
        // neither can tell an unguarded agent from a guarded one — so the capture
        // subject is left exactly as it stands, on the no_ack-only heal too,
        // because pointing a guarded agent's mailbox back at the raw inbox is the
        // very leak this exists to prevent.
        const subjectDrift =
          state !== "unknown" &&
          !(info.subjects.length === 1 && info.subjects[0] === want);
        if (info.repairs.length > 0 || subjectDrift) {
          // Switching TO guarded purges first, for the same reason setGuarded
          // does: whatever this stream already captured off the RAW inbox is
          // precisely the traffic admission would have dropped, and leaving it in
          // place hands it to the agent on its next offline drain — the leak
          // arriving late instead of live.
          if (subjectDrift && guarded) {
            try { await box.purge(); } catch { /* best effort */ }
          }
          await box.reconfigure(info, { repair: true, ...(subjectDrift ? { subjects: [want] } : {}) });
          console.log(
            `[registry] inbox buffer ${name} healed:` +
              info.repairs.map((r) => ` ${r}`).join("") +
              (subjectDrift ? ` now captures ${guarded ? ".guarded (admission-filtered)" : "the raw inbox"}` : ""),
          );
        }
        return;
      }
      const existing = await this.count();
      if (existing !== null && existing >= MAX_MAILBOXES) {
        // Live-only rather than durable, and loudly: an operator seeing this
        // either has a mailbox leak or has outgrown INBOX_BUFFER_MAX_MAILBOXES.
        console.error(
          `[registry] mailbox cap reached (${existing}/${MAX_MAILBOXES}): ${agentId.slice(0, 12)}… stays live-only. ` +
            `Raise INBOX_BUFFER_MAX_MAILBOXES if the disk allows.`,
        );
        return;
      }
      await box.create(spec);
      if (this.mailboxes !== null) this.mailboxes++;
      console.log(`[registry] inbox buffer created for ${agentId.slice(0, 12)}… (${MAX_BYTES / 1024 / 1024} MB / ${MAX_AGE_MS / 86_400_000}d${guarded ? ", admission-filtered" : ""})`);
    } catch (err) {
      console.error(`[registry] inbox buffer ensure failed for ${agentId.slice(0, 12)}…:`, err instanceof Error ? err.message : err);
    }
  }

  /** Point an agent's mailbox at the correct capture subject for its guard
   *  state. A GUARDED agent must buffer only admission-approved traffic
   *  (`.guarded`), never the raw inbox — otherwise the offline drain
   *  redelivers exactly the spam admission dropped (found by conformance
   *  c07). Switching to guarded purges any raw pre-guard captures so none
   *  slip through. No-op when there is no mailbox (sandbox). Never throws. */
  async setGuarded(agentId: string, guarded: boolean): Promise<void> {
    if (DISABLED) return;
    const raw = `mesh.agent.${agentId}.inbox`;
    const want = guarded ? `${raw}.guarded` : raw;
    try {
      const box = this.boxes.member(agentId);
      let info: StreamState | null = null;
      // The registry answers a registration once the mailbox is made, but only
      // up to a bound (handlers/register.ts, MAILBOX_WAIT_MS), so on guard
      // (which arrives right after register) the stream may still not exist.
      // Wait briefly for it — but never create one here: a sandbox agent has no
      // mailbox by design, and after the wait a genuine absence is a no-op.
      for (let i = 0; i < 12; i++) {
        try {
          info = await box.info();
          if (info) break;
        } catch { /* asked again below */ }
        if (!guarded) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!info) return; // no mailbox (sandbox / disabled) — nothing to point
      if (info.subjects.length === 1 && info.subjects[0] === want) return;
      if (guarded) { try { await box.purge(); } catch { /* best effort */ } }
      await box.reconfigure(info, { subjects: [want] });
      console.log(`[registry] inbox buffer for ${agentId.slice(0, 12)}… now captures ${guarded ? ".guarded (admission-filtered)" : "the raw inbox"}`);
    } catch (err) {
      console.error(`[registry] inbox buffer setGuarded failed for ${agentId.slice(0, 12)}…:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * How many messages wait in the agent's mailbox for the agent: what its own
   * drain consumer (`inbox_<id>`, sdk mesh.ts drainMailboxOnce) has not been
   * handed or has not acked, or, when it has never drained, everything the
   * mailbox holds. 0 when there is no mailbox; null when the server could not
   * be asked, which a caller deciding whether to delete treats as "some".
   */
  async pending(agentId: string): Promise<number | null> {
    if (DISABLED) return 0;
    try {
      const box = this.boxes.member(agentId);
      let held: number;
      try {
        const info = await box.info();
        if (!info) return 0;
        held = info.messages;
      } catch {
        return null;
      }
      try {
        const c = await box.consumerState(`inbox_${agentId}`);
        return c.pending + c.ackPending;
      } catch {
        return held;
      }
    } catch {
      return null;
    }
  }

  /**
   * Throw away the mail that arrived in the mailbox at or after `since` (ms
   * since the epoch), keeping the mailbox and everything older: the kill
   * switch's "discard what was held" at a resume, where `since` is the
   * stop's start. Mail that was already waiting before the stop (an agent
   * that was simply offline) is kept and delivered (owner, 2026-10-01; debt
   * 171). Returns how many messages went (0 when there is no mailbox).
   * Throws when the server could not be asked, so the resume can say the
   * mail was not discarded.
   */
  async discard(agentId: string, since: number): Promise<number> {
    if (DISABLED) return 0;
    return this.arrivedSince(agentId, since, true);
  }

  /**
   * How many messages arrived in the mailbox at or after `since`: the Resume
   * dialog's "the 6 messages that arrived while paused". 0 when there is no
   * mailbox. Throws when the server could not be asked.
   */
  async countSince(agentId: string, since: number): Promise<number> {
    if (DISABLED) return 0;
    return this.arrivedSince(agentId, since, false);
  }

  /** Walk the mailbox from its newest message back to the first one older
   *  than `since`, counting (and with `remove`, deleting) each newer one. A
   *  stream keeps messages in arrival order, so the walk stops at the first
   *  older message. Bounded, so a huge mailbox cannot hold a resume up. */
  private async arrivedSince(agentId: string, since: number, remove: boolean): Promise<number> {
    const box = this.boxes.member(agentId);
    const st = await box.info();
    if (!st || !st.messages) return 0;
    const first = st.firstSeq;
    const last = st.lastSeq;
    // A binding that holds the mailbox in two places (RabbitMQ: the record and
    // the queue the agent's node consumes) removes them together, after the
    // walk; JetStream removes each as the walk finds it, as it always has.
    const batch: number[] | null = remove && typeof box.removeMessages === "function" ? [] : null;
    let n = 0;
    for (let seq = last, steps = 0; seq >= first && steps < 20_000; seq--, steps++) {
      let at: number;
      let data: Uint8Array;
      try {
        const m = await box.read(seq);
        at = m.time.getTime();
        data = m.data;
      } catch (err) {
        // A gap (deleted, or aged out since the read above) is skipped.
        if (/not found|no message/i.test(err instanceof Error ? err.message : String(err))) continue;
        throw err;
      }
      if (at < since) break;
      if (batch) batch.push(seq);
      else if (remove) await box.removeMessage(seq);
      // The platform's own lifecycle request (the stop's "pause", sent as the
      // stop starts) is not mail anybody sent: it is discarded with the rest,
      // so a stale pause is never delivered after the resume, but never
      // counted (found live on dev, 2026-10-01: 3 counted where 2 were sent).
      if (!isLifecycle(data)) n++;
    }
    if (batch?.length) await box.removeMessages!(batch);
    return n;
  }

  /** Delete the buffer with its registration. Never throws. */
  async remove(agentId: string): Promise<void> {
    if (DISABLED) return;
    try {
      await this.boxes.member(agentId).destroy();
      if (this.mailboxes !== null && this.mailboxes > 0) this.mailboxes--;
      console.log(`[registry] inbox buffer removed for ${agentId.slice(0, 12)}…`);
    } catch { /* absent already — fine */ }
  }
}
