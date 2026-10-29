/**
 * Readable text generated from a signed message (Agent Messaging §5.8).
 *
 * When a carrier shows a person text that stands for a signed envelope (an
 * email's human part, an A2A text part), the text is generated from the
 * envelope and never written separately, and the signer puts the digest of
 * that text in the envelope's `meta`, where the signature covers it. Software
 * that shows the text checks it against the envelope and warns the person
 * when they differ. Agent Emailing §3.3 is this rule for email, with the
 * digest in `meta.agent_emailing.human_text`; every other carrier uses
 * `meta.readable_text`.
 *
 * This module holds the parts every carrier shares: the normalization, the
 * digest, the text for a message written to a person (§5.7), and the check.
 */
import type { Envelope } from "./types/envelope.js";

/** The version of the `meta.readable_text` object. */
export const READABLE_TEXT_VERSION = 1;

/** What a signer puts in `meta.readable_text`. */
export interface ReadableTextMeta {
  v: number;
  /** `sha256:` and the lowercase hex SHA-256 of the normalized text. */
  text: string;
}

/**
 * The normalized form the digest covers: line endings made LF, spaces and
 * tabs at the end of each line removed, and empty lines at the end removed.
 * The same normalization Agent Emailing §3.3 applies to an email's human part,
 * so a carrier that re-wraps line endings or trims trailing blanks does not
 * break the check.
 */
export function normalizeReadableText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** `sha256:<64 lowercase hex>` of the normalized text, encoded as UTF-8. */
export async function readableTextDigest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeReadableText(text));
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The `meta.readable_text` object for a text. */
export async function readableTextMeta(text: string): Promise<ReadableTextMeta> {
  return { v: READABLE_TEXT_VERSION, text: await readableTextDigest(text) };
}

/** The file names a message carries: a request's `payload.files` and the
 *  names of a respond's artifacts' file parts. */
export function fileNamesOf(env: Pick<Envelope, "payload" | "artifacts">): string[] {
  const names: string[] = [];
  const files = (env.payload as { files?: unknown } | undefined)?.files;
  if (Array.isArray(files)) {
    for (const f of files) {
      const n = (f as { name?: unknown } | null)?.name;
      if (typeof n === "string" && n) names.push(n);
    }
  }
  for (const a of (env.artifacts ?? []) as Array<{ name?: unknown; parts?: unknown }>) {
    const parts = Array.isArray(a?.parts) ? (a.parts as Array<{ name?: unknown }>) : [];
    for (const p of parts) if (typeof p?.name === "string" && p.name) names.push(p.name);
  }
  return names;
}

/**
 * The readable text of a message written to a person (§5.7): who sent it, the
 * message's own text word for word, and each attached file by name. Generated,
 * so a sender and a checker that hold the same envelope produce the same text.
 *
 * `sender` is the sender's handle where it is known, else its agent ID.
 */
export function personReadableText(input: { sender: string; text: string; files?: string[] }): string {
  const lines = [`From ${input.sender}`, "", input.text];
  const files = input.files ?? [];
  if (files.length) {
    lines.push("");
    for (const f of files) lines.push(`Attached: ${f}`);
  }
  return normalizeReadableText(lines.join("\n"));
}

/** Where a signed envelope keeps the digest of its readable text: the
 *  carrier-neutral `meta.readable_text`, or Agent Emailing's own member. */
export function signedReadableDigest(env: Pick<Envelope, "meta">): string | undefined {
  const meta = (env.meta ?? {}) as Record<string, unknown>;
  const rt = meta.readable_text as { text?: unknown } | undefined;
  if (rt && typeof rt.text === "string") return rt.text;
  const ae = meta.agent_emailing as { human_text?: unknown } | undefined;
  if (ae && typeof ae.human_text === "string") return ae.human_text;
  return undefined;
}

export type ReadableTextCheck =
  | { ok: true }
  | { ok: false; reasons: Array<"no_digest" | "digest_mismatch" | "text_missing" | "sender_missing" | "file_missing"> };

/**
 * The check software runs before it shows readable text to a person, after
 * the envelope's signature has verified (the caller's job, §5.3):
 *
 * 1. the envelope carries a signed digest, and the text's digest equals it;
 * 2. the text states the sender (its handle, where the caller knows it, or
 *    its agent ID), the message's own `payload.text` word for word, and every
 *    file name the envelope carries.
 *
 * Any failure means the software warns the person that the text differs from
 * the signed message, shows what the envelope says, and shows no sign that the
 * message was checked.
 */
export async function checkReadableText(
  env: Pick<Envelope, "from" | "payload" | "artifacts" | "meta">,
  text: string,
  opts: { senderHandle?: string } = {},
): Promise<ReadableTextCheck> {
  const reasons: Array<"no_digest" | "digest_mismatch" | "text_missing" | "sender_missing" | "file_missing"> = [];
  const signed = signedReadableDigest(env);
  if (!signed) reasons.push("no_digest");
  else if ((await readableTextDigest(text)) !== signed) reasons.push("digest_mismatch");
  const shown = normalizeReadableText(text);
  const own = (env.payload as { text?: unknown } | undefined)?.text;
  if (typeof own === "string" && own && !shown.includes(normalizeReadableText(own))) reasons.push("text_missing");
  const sender = opts.senderHandle ?? env.from;
  if (sender && !shown.includes(sender) && !shown.includes(env.from)) reasons.push("sender_missing");
  if (fileNamesOf(env).some((n) => !shown.includes(n))) reasons.push("file_missing");
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
