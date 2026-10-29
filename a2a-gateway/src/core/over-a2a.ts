/**
 * Agent Messaging over A2A (EXT-14 (messaging/extensions/EXT-14-agent-messaging-over-a2a.md)): the A2A extension that carries a
 * signed Agent Messaging envelope across the HTTPS leg, so a caller that holds
 * an Agent Messaging key signs its own request end to end and the gateway
 * passes it through instead of signing for a hosted identity. The answer comes
 * back with the responder's own signed envelope beside it.
 *
 * Pure functions: the checks the gateway runs on a carried envelope before it
 * relays it, and the shapes it writes. The relay itself is Bridge.relaySigned.
 */
import type { Envelope } from "../../../sdk-typescript/src/types/envelope.js";
import type { Manifest } from "../../../sdk-typescript/src/types/manifest.js";
import { verifyEnvelopeSig } from "../../../sdk-typescript/src/internal/identity.js";
import { MAX_CLOCK_SKEW_AHEAD_MS, MAX_CLOCK_SKEW_BEHIND_MS } from "../../../sdk-typescript/src/constants.js";
import { fileNamesOf, personReadableText, readableTextMeta } from "../../../sdk-typescript/src/readable-text.js";
import type { A2AMessage, A2APart } from "./jsonrpc.js";

export const OVER_A2A_URI = "mesh://extensions/agent-messaging-over-a2a/v1";
export const OVER_A2A_DESCRIPTION =
  "Agent Messaging over A2A: a caller that holds an Agent Messaging key carries its own signed envelope in this extension's metadata, and the gateway passes it through unchanged. Answers carry the agent's signed envelope.";

/** What this extension's metadata object may hold, on a message or a result. */
export interface OverA2AMetadata {
  /** A signed Agent Messaging envelope (Agent Messaging §5.1), `sig` included. */
  envelope?: unknown;
  /** On a text part: this part is the readable text generated from the
   *  envelope beside it (Agent Messaging §5.8). */
  readable_text?: boolean;
  /** A knock (EXT-14 §8): asks to be let in, with only `via` and `grants`. */
  knock?: unknown;
}

/** The extension's entry in a generated card's `capabilities.extensions[]`. */
export function overA2ACardExtension(): { uri: string; description: string; required: false; params: Record<string, unknown> } {
  return {
    uri: OVER_A2A_URI,
    description: OVER_A2A_DESCRIPTION,
    required: false,
    params: { signed_envelope: true, readable_text: true },
  };
}

/** Whether the caller activated the extension: its URI in the message's
 *  `extensions`, or in the `A2A-Extensions` header (A2A §3.2.6). */
export function overA2AActivated(message: A2AMessage | undefined, headerValue?: string): boolean {
  const listed = Array.isArray(message?.extensions) && message!.extensions!.includes(OVER_A2A_URI);
  const header = (headerValue ?? "").split(",").map((s) => s.trim()).includes(OVER_A2A_URI);
  return listed || header;
}

/** The extension's metadata object on a message, when present. */
export function overA2AMetadata(message: A2AMessage | undefined): OverA2AMetadata | undefined {
  const m = message?.metadata?.[OVER_A2A_URI];
  return m && typeof m === "object" && !Array.isArray(m) ? (m as OverA2AMetadata) : undefined;
}

/** The envelope a caller carried, or undefined when it carried none. */
export function carriedEnvelope(message: A2AMessage | undefined): unknown {
  return overA2AMetadata(message)?.envelope;
}

export type CarriedRefusal = {
  /** Why the carried envelope was refused, closed set (EXT-14 §4). */
  reason: "malformed" | "signature" | "type" | "addressee" | "stale" | "offering" | "mismatch";
  message: string;
};

/**
 * The checks a gateway runs on a carried request before it relays it
 * (EXT-14 §4). Any failure refuses the call and relays nothing.
 */
export function checkCarriedRequest(
  carried: unknown,
  ctx: { agentId: string; manifest: Manifest; message?: A2AMessage; now?: number },
): { ok: true; envelope: Envelope } | ({ ok: false } & CarriedRefusal) {
  const env = carried as Envelope;
  if (!env || typeof env !== "object" || Array.isArray(env) || typeof env.id !== "string" || typeof env.from !== "string" || typeof env.sig !== "string") {
    return { ok: false, reason: "malformed", message: "The carried envelope is not a signed Agent Messaging envelope (it needs id, from and sig)." };
  }
  let verified = false;
  try {
    verified = verifyEnvelopeSig(env);
  } catch {
    verified = false;
  }
  if (!verified) {
    return { ok: false, reason: "signature", message: `The carried envelope's signature does not verify against its 'from' (${env.from}).` };
  }
  if (env.type !== "request") {
    return { ok: false, reason: "type", message: `The carried envelope is a ${String(env.type)}; only a request is carried on SendMessage.` };
  }
  if (env.to !== ctx.agentId) {
    return { ok: false, reason: "addressee", message: "The carried envelope is addressed to a different agent than the one this interface serves." };
  }
  const ts = Date.parse(String(env.ts));
  const drift = (ctx.now ?? Date.now()) - ts;
  if (Number.isNaN(ts) || drift < -MAX_CLOCK_SKEW_AHEAD_MS || drift > MAX_CLOCK_SKEW_BEHIND_MS) {
    return { ok: false, reason: "stale", message: "The carried envelope's ts is outside the freshness window (Agent Messaging §22.3)." };
  }
  const payload = (env.payload ?? {}) as { offering?: unknown; text?: unknown };
  const personMarked = (env.meta as { audience?: unknown } | undefined)?.audience !== undefined && (env.meta as { audience?: unknown }).audience !== "agent";
  if (!personMarked) {
    const offering = payload.offering;
    const declared = ctx.manifest.offerings.map((o) => o.id);
    const builtin = offering === "task.cancel" || offering === "knock" || offering === "describe";
    if (typeof offering !== "string" || (!declared.includes(offering) && !builtin)) {
      return { ok: false, reason: "offering", message: `The carried request names an offering this agent does not declare. Declared: ${declared.join(", ")}` };
    }
  }
  const m = ctx.message;
  if (m?.taskId && m.taskId !== env.task_id) {
    return { ok: false, reason: "mismatch", message: "message.taskId differs from the carried envelope's task_id." };
  }
  if (m?.contextId && env.context_id && m.contextId !== env.context_id) {
    return { ok: false, reason: "mismatch", message: "message.contextId differs from the carried envelope's context_id." };
  }
  return { ok: true, envelope: env };
}

/** The extension's metadata for a result that carries the responder's own
 *  signed envelope. */
export function envelopeMetadata(env: Envelope | undefined): Record<string, unknown> {
  return env ? { [OVER_A2A_URI]: { envelope: env } } : {};
}

/** Whether a signed envelope is marked for a person (Agent Messaging §5.7). */
export function markedForPerson(env: Pick<Envelope, "meta"> | undefined): boolean {
  const a = (env?.meta as { audience?: unknown } | undefined)?.audience;
  return a !== undefined && a !== "agent";
}

/**
 * The readable text part for a message written to a person (Agent Messaging
 * §5.8): generated from the signed envelope, never written separately, and
 * marked so software that shows it knows to check it against the envelope
 * beside it.
 */
export function readableTextPart(env: Envelope, senderLabel?: string): A2APart {
  const text = (env.payload as { text?: unknown } | undefined)?.text;
  return {
    text: personReadableText({ sender: senderLabel ?? env.from, text: typeof text === "string" ? text : "", files: fileNamesOf(env) }),
    metadata: { [OVER_A2A_URI]: { readable_text: true } },
  } as A2APart;
}

/** The `meta.readable_text` a gateway signs onto a message for a person it
 *  sends for an A2A caller with no key of its own. */
export async function readableTextFor(sender: string, text: string): Promise<{ v: number; text: string }> {
  return readableTextMeta(personReadableText({ sender, text }));
}

// ─── The conversation and the knock (EXT-14 §7, §8) ────────────────────

/**
 * A2A task-status fields for a mesh state. A2A has no `exhausted`; the
 * gateway maps it to `canceled` (MAPPING.md §5) and says so in the task's
 * metadata, `agentmesh.state`, so a caller can tell work that stopped at its
 * cap from work somebody canceled.
 */
export function stateMetadata(meshState: string | undefined): Record<string, unknown> {
  return meshState === "exhausted" ? { "agentmesh.state": "exhausted" } : {};
}

/** What an A2A caller may put in a knock (EXT-6 §9.3): `via` and `grants`,
 *  nothing else, and never words. */
export function knockInput(raw: unknown): { ok: true; input: { via?: string; grants: string[] } } | { ok: false; message: string } {
  if (raw === true || raw === undefined || raw === null) return { ok: true, input: { grants: [] } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "A knock is an object with only via and grants." };
  const { via, grants, ...rest } = raw as { via?: unknown; grants?: unknown };
  if (Object.keys(rest).length) return { ok: false, message: `A knock carries no message: ${Object.keys(rest).join(", ")} cannot ride on one. Say it after you are let in.` };
  if (via !== undefined && (typeof via !== "string" || via.length > 80)) return { ok: false, message: "A knock's via is a label of at most 80 characters." };
  if (grants !== undefined && (!Array.isArray(grants) || grants.some((g) => typeof g !== "string"))) return { ok: false, message: "A knock's grants is a list of grant names." };
  return { ok: true, input: { ...(typeof via === "string" ? { via } : {}), grants: (grants as string[] | undefined) ?? [] } };
}

/** The status message of a first contact the agent's door holds. The same
 *  words whether the door holds it, blocks it, or the agent does not exist,
 *  as on the mesh (EXT-6 §9.3). */
export const HELD_SENTENCE =
  "This agent's owner has not let you in. What you sent is with the owner, who decides whether to admit you, and nothing reaches the agent until they do. If they let you in, it is delivered, and a reply that names this request lands on this task, so poll GetTask. To ask to be let in without sending anything, send a knock: a message that lists mesh://extensions/agent-messaging-over-a2a/v1 in extensions, with { \"knock\": {} } under that URI in metadata.";

/** The answer to a knock from a caller the door has not let in. */
export const KNOCK_SENTENCE =
  "Your knock is with this agent's owner. You are not let in yet, or there is no such agent; the answer is the same either way. Nothing more is needed from you: send your message again once you are let in.";
