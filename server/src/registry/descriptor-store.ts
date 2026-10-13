/**
 * Agent Descriptor storage (Common Agent spec §6.7): the registry keeps the
 * current descriptor per subject and every version it has ever stored by
 * digest, and serves both. The digest is SHA-256 over the exact bytes
 * submitted, with no canonicalization (§6) — so both buckets store the raw
 * bytes, and nothing here ever reserializes a descriptor.
 *
 * Two buckets rather than KV history: a signed reference must stay
 * fetchable for as long as the subject is served at all (§8.4), and KV
 * history is a bounded cache that silently sheds old revisions. Same
 * decision the standing-proposal store made for the same reason.
 */
import { createHash } from "node:crypto";
import { storageOf, type KeyedStore, type StorageLike } from "../storage/index.js";
import { canonicalJSON, nkeys, validateDescriptorTrials } from "../sdk.js";

export const DESCRIPTOR_FORMAT = "agent-descriptor-v1";
export const DESCRIPTOR_SIGNATURE_TAG = "descriptor-statement-v1";

/** Well below the KV value ceiling, far above any honest descriptor. */
export const DESCRIPTOR_MAX_BYTES = 65536;

export interface StoredDescriptor {
  bytes: Uint8Array;
  digest: string;
}

export function descriptorDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Validate a submitted descriptor against the spec's mechanical checks
 * (Common Agent spec §6.8) plus the registry's own gate: the subject must be
 * the authenticated sender, because the registry stores an operator's word
 * about their own agent and nobody else's.
 *
 * Returns null when the document passes, else one sentence saying why not.
 * Pure, so the unit tests can drive it without a broker.
 */
export function validateDescriptor(bytes: Uint8Array, senderKey: string): string | null {
  if (bytes.length === 0) return "The descriptor is empty.";
  if (bytes.length > DESCRIPTOR_MAX_BYTES) {
    return `The descriptor is ${bytes.length} bytes; the registry accepts at most ${DESCRIPTOR_MAX_BYTES}.`;
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return "The descriptor is not valid UTF-8 JSON.";
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return "The descriptor is not a JSON object.";
  }

  if (doc.format !== DESCRIPTOR_FORMAT) {
    return `format must be "${DESCRIPTOR_FORMAT}".`;
  }
  const version = doc.agent_version;
  if (typeof version !== "string" && typeof version !== "number") {
    return "agent_version is required.";
  }
  if (typeof version === "string" && version.trim() === "") {
    return "agent_version is required.";
  }
  if (typeof doc.does !== "string" || doc.does.trim() === "") {
    return "does is required: one sentence on what the agent does.";
  }

  // Bound only (§3.1): a registry MUST NOT store a draft as an agent's
  // descriptor, and the subject must be the sender.
  const subject = doc.subject as { id?: unknown } | undefined;
  if (!subject || typeof subject !== "object" || typeof subject.id !== "string") {
    return "The descriptor is a draft (no subject); the registry stores only bound descriptors.";
  }
  if (subject.id !== senderKey) {
    return "subject.id must be the submitting agent's own key.";
  }

  // A signature is optional here (§7 says SHOULD), but a present
  // descriptor-statement-v1 entry must verify and must be the subject's own.
  const signatures = doc.signatures;
  if (signatures !== undefined) {
    if (!Array.isArray(signatures)) return "signatures must be an array.";
    for (const entry of signatures as Array<Record<string, unknown>>) {
      if (!entry || entry.tag !== DESCRIPTOR_SIGNATURE_TAG) continue;
      if (entry.by !== subject.id) {
        return `A ${DESCRIPTOR_SIGNATURE_TAG} signature must be by the subject's own key.`;
      }
      if (typeof entry.sig !== "string") {
        return "The signature entry has no sig.";
      }
      const { signatures: _s, ...body } = doc;
      const message = `${DESCRIPTOR_SIGNATURE_TAG}\n${canonicalJSON(body)}`;
      let ok = false;
      try {
        const pub = nkeys.fromPublic(subject.id);
        ok = pub.verify(
          new TextEncoder().encode(message),
          Uint8Array.from(Buffer.from(entry.sig, "base64")),
        );
      } catch {
        ok = false;
      }
      if (!ok) return "The descriptor's signature does not verify.";
    }
  }

  // Common Agent §7.7: a trial with no count is not bounded, and a registry
  // MUST refuse it; so is a trial whose shape names what the offering does
  // not declare, and a samples_ref that is not an https address.
  const trials = validateDescriptorTrials(doc);
  if (trials !== null) return trials;

  return null;
}

/**
 * Read an owner-authored descriptor DRAFT from the app's editor (item 2 of
 * the UX plan): the standing description without subject or signatures,
 * which the agent adds when it adopts. Forgiving where the registry gate is
 * strict — this is a form being filled, not a wire submission — but it
 * refuses the two things that would poison the document: a wrong format
 * marker, and members that are not the descriptor's own.
 */
export function readDescriptorDraft(
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "descriptor must be an object" };
  }
  const d = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { format: DESCRIPTOR_FORMAT };
  if (d.format !== undefined && d.format !== DESCRIPTOR_FORMAT) {
    return { ok: false, error: `format must be "${DESCRIPTOR_FORMAT}"` };
  }
  const version = d.agent_version;
  if ((typeof version !== "string" || !version.trim()) && typeof version !== "number") {
    return { ok: false, error: "agent_version is required" };
  }
  out.agent_version = String(version);
  if (typeof d.does !== "string" || !d.does.trim()) {
    return { ok: false, error: "does is required: one sentence on what the agent does" };
  }
  out.does = d.does.trim();
  if (d.offerings !== undefined) {
    if (!Array.isArray(d.offerings)) return { ok: false, error: "offerings must be an array" };
    for (const o of d.offerings as Array<Record<string, unknown>>) {
      if (typeof o !== "object" || o === null || typeof o.id !== "string" || !o.id.trim()) {
        return { ok: false, error: "each offering needs at least an id" };
      }
      for (const side of ["inputs", "outputs"] as const) {
        const v = o[side];
        if (v === undefined) continue;
        if (!Array.isArray(v) || !v.every((e) =>
          typeof e === "object" && e !== null &&
          typeof (e as Record<string, unknown>).name === "string" &&
          typeof (e as Record<string, unknown>).kind === "string")) {
          return { ok: false, error: `offering ${o.id}: each of ${side} needs a name and a kind` };
        }
      }
    }
    // §7.7: the same trial rule the registry applies to a bound descriptor.
    const trials = validateDescriptorTrials({ offerings: d.offerings });
    if (trials !== null) return { ok: false, error: trials };
    out.offerings = d.offerings;
  }
  if (d.samples_ref !== undefined) {
    const why = validateDescriptorTrials({ samples_ref: d.samples_ref, offerings: [] });
    if (why !== null) return { ok: false, error: why };
    out.samples_ref = d.samples_ref;
  }
  if (d.interaction !== undefined) {
    if (d.interaction !== "interactive" && d.interaction !== "service") {
      return { ok: false, error: "interaction must be interactive or service" };
    }
    out.interaction = d.interaction;
  }
  if (d.refusals !== undefined) {
    if (typeof d.refusals !== "string") return { ok: false, error: "refusals must be prose" };
    if (d.refusals.trim()) out.refusals = d.refusals.trim();
  }
  if (d.hosted_in !== undefined) {
    if (!Array.isArray(d.hosted_in) || !d.hosted_in.every((r) => typeof r === "string" && r.trim())) {
      return { ok: false, error: "hosted_in must be a list of regions" };
    }
    if (d.hosted_in.length) out.hosted_in = d.hosted_in;
  }
  for (const k of ["role"] as const) {
    if (d[k] !== undefined && typeof d[k] === "string" && (d[k] as string).trim()) out[k] = (d[k] as string).trim();
  }
  if (d.interfaces !== undefined) {
    if (!Array.isArray(d.interfaces) || !d.interfaces.every((i) => typeof i === "string")) {
      return { ok: false, error: "interfaces must be a list of names" };
    }
    if (d.interfaces.length) out.interfaces = d.interfaces;
  }
  for (const k of ["shape", "systems", "limits"] as const) {
    if (d[k] !== undefined && typeof d[k] === "object" && d[k] !== null) out[k] = d[k];
  }
  // The agent's own members never arrive from an editor.
  // (subject and signatures are simply not read; anything else unknown is
  // dropped rather than carried, so a typo cannot become a published claim.)
  const bytes = new TextEncoder().encode(JSON.stringify(out));
  if (bytes.length > DESCRIPTOR_MAX_BYTES) {
    return { ok: false, error: "the descriptor draft is too large" };
  }
  return { ok: true, value: out };
}

export class DescriptorStore {
  private constructor(
    /** Current descriptor per subject: key = agent public key, value = raw bytes. */
    private readonly current: KeyedStore,
    /** Every version ever stored: key = sha-256 hex digest, value = raw bytes. */
    private readonly archive: KeyedStore,
  ) {}

  static async create(js: StorageLike): Promise<DescriptorStore> {
    const storage = storageOf(js);
    const current = await storage.keyed("mesh_descriptors");
    const archive = await storage.keyed("mesh_descriptor_archive");
    return new DescriptorStore(current, archive);
  }

  /**
   * Store a validated descriptor. Archive first, then current: a crash
   * between the two leaves an unreferenced archive entry, which is harmless,
   * where the other order could leave a current version history cannot serve.
   * Returns the digest, and whether this replaced a different version.
   */
  async put(senderKey: string, bytes: Uint8Array): Promise<{ digest: string; replaced: boolean }> {
    const digest = descriptorDigest(bytes);
    const prior = await this.current.get(senderKey);
    const replaced =
      prior !== null && prior.value.length > 0 && descriptorDigest(prior.value) !== digest;
    await this.archive.put(digest, bytes);
    await this.current.put(senderKey, bytes);
    return { digest, replaced };
  }

  async getCurrent(agentKey: string): Promise<StoredDescriptor | null> {
    const entry = await this.current.get(agentKey);
    if (!entry || entry.value.length === 0) return null;
    return { bytes: entry.value, digest: descriptorDigest(entry.value) };
  }

  /** Drop an agent's current descriptor (account closure). The by-digest
   *  archive is kept: it is evidence others may cite (closure-registry.ts). */
  async forget(agentKey: string): Promise<void> {
    await this.current.purge(agentKey);
  }

  async getByDigest(digest: string): Promise<StoredDescriptor | null> {
    if (!/^[0-9a-f]{64}$/.test(digest)) return null;
    const entry = await this.archive.get(digest);
    if (!entry || entry.value.length === 0) return null;
    return { bytes: entry.value, digest };
  }
}
