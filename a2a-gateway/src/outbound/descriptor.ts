/**
 * The attachment's Agent Descriptor: what the gateway says about an attached
 * A2A agent to the registry, as that agent's own hosted identity.
 *
 * An A2A card says what an agent offers. It has no place for what the agent
 * refuses to do or what it keeps of the work, and those are exactly the parts
 * a careful caller reads before it hands anything over. The owner says them
 * in the attachment's statement (store.ts), and this module turns the card
 * plus the statement into an `agent-descriptor-v1` document (the format the
 * registry's descriptor store checks; AgentMesh's docs/agent-descriptor-v1.md
 * describes its members).
 *
 * Three pieces, kept apart so each can be tested alone:
 *
 *   parseStatement          the admin input, checked and normalized;
 *   descriptorForAttachment the document, built from plain data, no I/O;
 *   publishDescriptor       the put, as the attachment's own agent.
 */
import type { AgentCard } from "../core/card.js";
import type { AttachmentStatement } from "./store.js";

export const DESCRIPTOR_FORMAT = "agent-descriptor-v1";
/** The registry's request subject for "this is my current descriptor". */
export const DESCRIPTOR_PUT_SUBJECT = "mesh.registry.descriptor.put";
/** The registry's own ceiling (server/src/registry/descriptor-store.ts). A
 *  descriptor over it is refused there; checking here first gives the owner
 *  a plainer reason than a round trip would. */
export const DESCRIPTOR_MAX_BYTES = 65536;

export const REFUSALS_MAX_CHARS = 2000;
export const RECORDS_MAX = 20;
export const RECORD_NAME_MAX_CHARS = 120;

const STATEMENT_KEYS = new Set(["refusals", "records"]);

/**
 * Check and normalize an owner's statement from the admin API.
 *
 * Answers `{ statement }` (null when the owner said nothing) or `{ error }`,
 * one sentence, which the caller turns into a 422. The rules:
 *
 *   - the statement is an object with no keys but `refusals` and `records`
 *     (a typo that silently stores nothing is how an owner comes to believe
 *     a refusal is published when it is not);
 *   - `refusals` is a string, trimmed, at most 2000 characters;
 *   - `records` is an array of at most 20 strings, each trimmed, non-empty,
 *     at most 120 characters, and no two the same;
 *   - an empty `refusals` and an empty `records` are the same as leaving them
 *     out, and a statement with neither is null: there is nothing to say.
 *
 * `undefined` and `null`, for the whole statement or for either member, read
 * as "not given".
 */
export function parseStatement(
  input: unknown,
): { statement: AttachmentStatement | null } | { error: string } {
  if (input === undefined || input === null) return { statement: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { error: "The statement must be an object with refusals and records." };
  }
  const body = input as Record<string, unknown>;
  const unknown = Object.keys(body).filter((k) => !STATEMENT_KEYS.has(k));
  if (unknown.length) {
    return { error: `The statement takes only refusals and records, not ${unknown.join(", ")}.` };
  }

  const out: AttachmentStatement = {};

  if (body.refusals !== undefined && body.refusals !== null) {
    if (typeof body.refusals !== "string") {
      return { error: "refusals must be a string." };
    }
    const refusals = body.refusals.trim();
    if (refusals.length > REFUSALS_MAX_CHARS) {
      return { error: `refusals is ${refusals.length} characters; the most it may be is ${REFUSALS_MAX_CHARS}.` };
    }
    if (refusals) out.refusals = refusals;
  }

  if (body.records !== undefined && body.records !== null) {
    if (!Array.isArray(body.records)) {
      return { error: "records must be an array of strings." };
    }
    if (body.records.length > RECORDS_MAX) {
      return { error: `records names ${body.records.length} records; the most it may name is ${RECORDS_MAX}.` };
    }
    const seen = new Set<string>();
    const records: string[] = [];
    for (const raw of body.records) {
      if (typeof raw !== "string") {
        return { error: "Every entry in records must be a string." };
      }
      const name = raw.trim();
      if (!name) {
        return { error: "An entry in records is empty." };
      }
      if (name.length > RECORD_NAME_MAX_CHARS) {
        return { error: `The record "${name.slice(0, 40)}..." is longer than ${RECORD_NAME_MAX_CHARS} characters.` };
      }
      if (seen.has(name)) {
        return { error: `records names "${name}" twice.` };
      }
      seen.add(name);
      records.push(name);
    }
    if (records.length) out.records = records;
  }

  return { statement: out.refusals !== undefined || out.records !== undefined ? out : null };
}

/** One offering the attachment exposes, as attach.ts builds it from the card. */
export interface ExposedOffering {
  id: string;
  name?: string;
  description?: string;
}

/** The descriptor document, as it goes to the registry. */
export interface AttachmentDescriptor {
  format: typeof DESCRIPTOR_FORMAT;
  agent_version: string;
  subject: { id: string };
  does: string;
  offerings: Array<{ id: string; name: string; does?: string }>;
  interaction: "service";
  refusals?: string;
  records?: Array<{ name: string; when: "per_task" }>;
}

/**
 * Build the descriptor for an attachment. Pure: the same inputs always make
 * the same document, and nothing here touches the mesh.
 *
 *   - `agent_version` is the card's version, or "0" when the card gives none
 *     (the registry requires one, and an empty string does not count);
 *   - `subject.id` is the attachment's own agent key, because the registry
 *     stores only a descriptor whose subject is the agent that sent it;
 *   - `does` is the card's description, or its name when the description is
 *     empty (the registry requires a sentence, and the name is the most the
 *     card offers in its place);
 *   - `offerings` are only the ones the attachment EXPOSES. A skill the owner
 *     chose not to stand behind is not on the mesh, and a descriptor that
 *     listed it would describe an agent nobody can reach;
 *   - `interaction` is "service": an attached A2A agent answers requests, it
 *     does not hold a conversation on the mesh;
 *   - `refusals` and `records` appear only when the statement has them. Every
 *     record is kept "per_task", the one cadence a forwarded call has.
 */
export function descriptorForAttachment(input: {
  card: Pick<AgentCard, "name" | "description" | "version">;
  agentId: string;
  offerings: ExposedOffering[];
  statement: AttachmentStatement | null | undefined;
}): AttachmentDescriptor {
  const { card, agentId, offerings, statement } = input;
  const version = typeof card.version === "string" ? card.version.trim() : "";
  const description = typeof card.description === "string" ? card.description.trim() : "";
  return {
    format: DESCRIPTOR_FORMAT,
    agent_version: version || "0",
    subject: { id: agentId },
    does: description || card.name,
    offerings: offerings.map((o) => {
      const does = typeof o.description === "string" ? o.description.trim() : "";
      return { id: o.id, name: o.name?.trim() || o.id, ...(does ? { does } : {}) };
    }),
    interaction: "service",
    ...(statement?.refusals ? { refusals: statement.refusals } : {}),
    ...(statement?.records?.length
      ? { records: statement.records.map((name) => ({ name, when: "per_task" as const })) }
      : {}),
  };
}

/** The descriptor as the bytes the registry digests: compact JSON, UTF-8. */
export function descriptorBytes(doc: AttachmentDescriptor): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}

/** What the put needs from a hosted agent: its signed service request. */
export interface DescriptorSender {
  serviceRequest(subject: string, payload: unknown, timeoutMs?: number): Promise<unknown>;
}

const PUT_TIMEOUT_MS = 10_000;

/**
 * Put the descriptor as the attachment's own agent. Resolves when the
 * registry accepted it; rejects with the registry's reason when it did not.
 * The caller decides what a failure means (for an attachment: a note on the
 * record, never a reason to stop serving).
 */
export async function publishDescriptor(agent: DescriptorSender, doc: AttachmentDescriptor): Promise<void> {
  const bytes = descriptorBytes(doc);
  if (bytes.length > DESCRIPTOR_MAX_BYTES) {
    throw new Error(
      `The descriptor is ${bytes.length} bytes; the registry accepts at most ${DESCRIPTOR_MAX_BYTES}. ` +
        `The card's descriptions are the likely cause.`,
    );
  }
  await agent.serviceRequest(
    DESCRIPTOR_PUT_SUBJECT,
    { descriptor: Buffer.from(bytes).toString("base64") },
    PUT_TIMEOUT_MS,
  );
}
