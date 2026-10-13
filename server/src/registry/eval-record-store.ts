/**
 * Evaluation record storage (Common Agent spec §9.4): the registry keeps the
 * latest signed eval verdict per SUBJECT and every record it has ever stored
 * by digest, and serves both. The digest is SHA-256 over the exact bytes
 * submitted, with no canonicalization — so both buckets store the raw bytes,
 * and nothing here ever reserializes a record. Same two-bucket decision the
 * descriptor store made, for the same reason: a referenced version must stay
 * fetchable, and KV history is a bounded cache that silently sheds old
 * revisions.
 *
 * The gate differs from the descriptor store's in one deliberate way: an
 * EVALUATOR signs and submits records about OTHER agents, so the sender is
 * the signer, never the subject. The latest bucket is keyed by the subject
 * the record names.
 */
import { createHash } from "node:crypto";
import { storageOf, type KeyedStore, type StorageLike } from "../storage/index.js";
import { canonicalJSON, nkeys } from "../sdk.js";

export const EVAL_RECORD_SIGNATURE_TAG = "agent-eval-record-v1";

/** Well below the KV value ceiling, far above any honest record. */
export const EVAL_RECORD_MAX_BYTES = 262144;

export interface StoredEvalRecord {
  bytes: Uint8Array;
  digest: string;
}

export function evalRecordDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Validate a submitted eval record. The registry's gate: the record must
 * carry an agent-eval-record-v1 signature BY the authenticated sender, and
 * that signature must verify — the registry stores an evaluator's signed
 * word about somebody else's agent, so the signature is required where the
 * descriptor store's is optional (an unauthenticated verdict about a third
 * party is nothing at all).
 *
 * Returns the subject key the record names when the document passes, else
 * one sentence saying why not. Pure, so the unit tests can drive it without
 * a broker.
 */
export function validateEvalRecord(
  bytes: Uint8Array,
  senderKey: string,
): { ok: true; subject: string } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: "The record is empty." };
  if (bytes.length > EVAL_RECORD_MAX_BYTES) {
    return {
      ok: false,
      error: `The record is ${bytes.length} bytes; the registry accepts at most ${EVAL_RECORD_MAX_BYTES}.`,
    };
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, error: "The record is not valid UTF-8 JSON." };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, error: "The record is not a JSON object." };
  }

  // The subject the verdict is about — the key the latest bucket is keyed by.
  const subject = doc.subject as { agent_key?: unknown } | undefined;
  if (
    !subject ||
    typeof subject !== "object" ||
    typeof subject.agent_key !== "string" ||
    subject.agent_key.trim() === ""
  ) {
    return { ok: false, error: "subject.agent_key is required: the record must name the evaluated agent." };
  }

  const signatures = doc.signatures;
  if (!Array.isArray(signatures)) {
    return { ok: false, error: "signatures must be an array." };
  }
  const entry = (signatures as Array<Record<string, unknown>>).find(
    (s) => s && s.tag === EVAL_RECORD_SIGNATURE_TAG,
  );
  if (!entry) {
    return { ok: false, error: `The record carries no ${EVAL_RECORD_SIGNATURE_TAG} signature.` };
  }
  if (entry.by !== senderKey) {
    return {
      ok: false,
      error: `A ${EVAL_RECORD_SIGNATURE_TAG} signature must be by the submitting evaluator's own key.`,
    };
  }
  if (typeof entry.sig !== "string") {
    return { ok: false, error: "The signature entry has no sig." };
  }
  const { signatures: _s, ...body } = doc;
  const message = `${EVAL_RECORD_SIGNATURE_TAG}\n${canonicalJSON(body)}`;
  let verified = false;
  try {
    const pub = nkeys.fromPublic(senderKey);
    verified = pub.verify(
      new TextEncoder().encode(message),
      Uint8Array.from(Buffer.from(entry.sig, "base64")),
    );
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, error: "The record's signature does not verify." };

  return { ok: true, subject: subject.agent_key };
}

export class EvalRecordStore {
  private constructor(
    /** Latest record per subject: key = evaluated agent's public key, value = raw bytes. */
    private readonly current: KeyedStore,
    /** Every record ever stored: key = sha-256 hex digest, value = raw bytes. */
    private readonly archive: KeyedStore,
  ) {}

  static async create(js: StorageLike): Promise<EvalRecordStore> {
    const storage = storageOf(js);
    const current = await storage.keyed("mesh_eval_records");
    const archive = await storage.keyed("mesh_eval_record_archive");
    return new EvalRecordStore(current, archive);
  }

  /**
   * Store a validated record under the subject it names. Archive first, then
   * current: a crash between the two leaves an unreferenced archive entry,
   * which is harmless, where the other order could leave a current version
   * history cannot serve. Returns the digest, and whether this replaced a
   * different record.
   */
  async put(subjectKey: string, bytes: Uint8Array): Promise<{ digest: string; replaced: boolean }> {
    const digest = evalRecordDigest(bytes);
    const prior = await this.current.get(subjectKey);
    const replaced =
      prior !== null && prior.value.length > 0 && evalRecordDigest(prior.value) !== digest;
    await this.archive.put(digest, bytes);
    await this.current.put(subjectKey, bytes);
    return { digest, replaced };
  }

  async getCurrent(subjectKey: string): Promise<StoredEvalRecord | null> {
    const entry = await this.current.get(subjectKey);
    if (!entry || entry.value.length === 0) return null;
    return { bytes: entry.value, digest: evalRecordDigest(entry.value) };
  }

  async getByDigest(digest: string): Promise<StoredEvalRecord | null> {
    if (!/^[0-9a-f]{64}$/.test(digest)) return null;
    const entry = await this.archive.get(digest);
    if (!entry || entry.value.length === 0) return null;
    return { bytes: entry.value, digest };
  }
}
