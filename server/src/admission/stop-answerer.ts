/**
 * Answering for a stopped agent (docs/kill-switch-plan.md item 3).
 *
 * A paused agent is off the mesh: the kill switch cut its connection and its
 * node's credential no longer carries its inbox. Mail sent to it is still
 * captured by its inbox buffer (registry/inbox-buffer.ts), which is what "mail
 * waits" means, but nobody answers the sender, who would otherwise see only a
 * silence. So the admission service, the one intermediary the SDK already
 * accepts an answer from on an agent's behalf (EXT-6, `requirePinnedIntermediary`),
 * subscribes to each stopped agent's inbox while it is stopped and answers:
 *
 *   - paused:     "This agent is paused. Your message waits in its inbox and
 *                  is delivered when it resumes." (a queued answer, not an
 *                  error: the message really is kept);
 *   - terminated: "This agent was terminated. Your message was not
 *                  delivered." (an error; its buffer is deleted when it is
 *                  deregistered, so nothing is kept);
 *   - its signing key revoked (§4.10), while it is paused: "This agent's
 *                  signing key was revoked. Your message was not delivered."
 *                  (an error: a revoked key deregisters the agent and removes
 *                  its buffer, so telling the sender the message waits would
 *                  be untrue).
 *
 * The answer goes where every §6.4 answer goes, the sender's own inbox, and
 * also on the transport reply subject when there is one, as the benign ack
 * does. Only requests are answered: an answer to an answer is never awaited.
 *
 * Which agents are stopped comes from the kill switch's per-agent status
 * (shared/agent-status.ts), followed live. A guarded agent (EXT-6) is answered
 * by the guard's own relay, which asks the same status.
 */
import type { BusMessage, BusSubscription, Messaging } from "../storage/index.js";
import { createEnvelope, ErrorCode, Subjects, decode, uuid7 } from "../sdk.js";
import { idOf, sealEnvelope, type ServiceIdentity } from "../shared/handler.js";
import { serviceQueue } from "../shared/queue-groups.js";
import type { AgentStatusEntry } from "../shared/agent-status.js";
import { AGENT_KEY_REVOKED, type AgentKeyRevocation, type AgentKeyRevocationLookup } from "../shared/agent-key-revocations.js";

export const PAUSED_TEXT = "This agent is paused. Your message waits in its inbox and is delivered when it resumes.";
export const TERMINATED_TEXT = "This agent was terminated. Your message was not delivered.";
export const REVOKED_TEXT = "This agent's signing key was revoked. Your message was not delivered.";

/** What the answer says: the stop's own status, or `revoked` for an agent
 *  whose signing key was revoked while it was stopped. */
export type StopAnswerStatus = AgentStatusEntry["status"] | "revoked";

/** The status to answer with: a termination says so; a revoked key outranks
 *  a pause, whose "your message waits" would no longer be true. */
export function answerStatus(status: AgentStatusEntry["status"], revocation: AgentKeyRevocation | null | undefined): StopAnswerStatus {
  if (status === "terminated") return "terminated";
  return revocation ? "revoked" : status;
}

/** The signed answer to one request sent to a stopped agent. */
export function stopNotice(
  req: { id?: string; from?: string; trace?: unknown },
  recipient: string,
  status: StopAnswerStatus,
  kp: ServiceIdentity,
  revocation?: AgentKeyRevocation | null,
): Uint8Array {
  const env = status === "revoked"
    ? createEnvelope({
        type: "respond",
        from: idOf(kp),
        to: req.from,
        in_reply_to: req.id,
        error: {
          code: ErrorCode.AGENT_UNAVAILABLE,
          message: REVOKED_TEXT,
          details: {
            reason: AGENT_KEY_REVOKED,
            agent: recipient,
            ...(revocation?.at ? { revoked_at: revocation.at } : {}),
            ...(revocation?.replaced_by ? { replaced_by: revocation.replaced_by } : {}),
          },
          retryable: false,
        },
      })
    : status === "terminated"
    ? createEnvelope({
        type: "respond",
        from: idOf(kp),
        to: req.from,
        in_reply_to: req.id,
        error: {
          code: ErrorCode.AGENT_UNAVAILABLE,
          message: TERMINATED_TEXT,
          details: { reason: "agent_terminated", agent: recipient },
          retryable: false,
        },
      })
    : createEnvelope({
        type: "respond",
        from: idOf(kp),
        to: req.from,
        in_reply_to: req.id,
        payload: { output: { queued: true, paused: true, code: "agent_paused", inbox_id: uuid7(), text: PAUSED_TEXT } },
      });
  return sealEnvelope(env, kp);
}

/** Send the notice to the sender's inbox and, when present, the reply subject. */
export function answerStopped(nc: Pick<Messaging, "publish">, msg: Pick<BusMessage, "reply" | "respond">, req: { id?: string; from?: string; type?: string }, recipient: string, status: StopAnswerStatus, kp: ServiceIdentity, revocation?: AgentKeyRevocation | null): boolean {
  if (req.type !== "request") return false;
  const bytes = stopNotice(req, recipient, status, kp, revocation);
  if (msg.reply) msg.respond(bytes);
  if (req.from) {
    try { nc.publish(Subjects.agentInbox(req.from), bytes); } catch { /* unaddressable sender */ }
  }
  return true;
}

export class StopAnswerer {
  private subs = new Map<string, { sub: BusSubscription; status: AgentStatusEntry["status"] }>();

  constructor(
    private nc: Messaging,
    private kp: ServiceIdentity,
    /** True when this agent is guarded: its guard relay answers instead. */
    private guarded: (agentKey: string) => boolean,
    /** The registry's record of revoked signing keys (§4.10). Absent: every
     *  stopped agent is answered by its stop alone, as before. */
    private revocations?: AgentKeyRevocationLookup,
  ) {}

  /** Apply one status change (from `AgentStatusStore.follow`). */
  onStatus(agentKey: string, rec: AgentStatusEntry | null): void {
    const held = this.subs.get(agentKey);
    if (!rec || this.guarded(agentKey)) {
      held?.sub.unsubscribe();
      this.subs.delete(agentKey);
      return;
    }
    if (held) {
      held.status = rec.status;
      return;
    }
    let subject: string;
    try { subject = Subjects.agentInbox(agentKey); } catch { return; }
    // Its own queue group, so two admission instances answer each message once.
    const sub = this.nc.subscribe(subject, { queue: `${serviceQueue(subject)}.stopped` });
    const entry = { sub, status: rec.status };
    this.subs.set(agentKey, entry);
    void (async () => {
      for await (const msg of sub) {
        let req: { id?: string; from?: string; type?: string } | undefined;
        try { req = decode(msg.data) as typeof req; } catch { continue; }
        if (!req) continue;
        const revocation = this.revocations ? await this.revocations.get(agentKey).catch(() => null) : null;
        answerStopped(this.nc, msg, req, agentKey, answerStatus(entry.status, revocation), this.kp, revocation);
      }
    })();
  }

  get size(): number {
    return this.subs.size;
  }

  stop(): void {
    for (const { sub } of this.subs.values()) sub.unsubscribe();
    this.subs.clear();
  }
}
