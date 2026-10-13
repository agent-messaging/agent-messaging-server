/**
 * The dossier: what a finished job leaves behind when the room is gone.
 *
 * A durable room is deleted when its creator reclaims it, and automatically
 * after three days idle — record, drive and all. That is the right policy for a
 * conversation and the wrong one for a job: a deliverable somebody formally
 * accepted should not evaporate because nobody spoke for a weekend, and neither
 * should the record proving how it was produced.
 *
 * So closing a job produces one self-contained document instead:
 *
 *   - the full record, entry for entry;
 *   - the ACCEPTED outputs, bytes included;
 *   - every other file by name, size, origin and DIGEST, without its bytes.
 *
 * That last line is the whole trick. Digests outlive bytes. Long after an input
 * has been discarded you can still take a copy someone hands you, hash it, and
 * say whether it is the one the job actually used — which is most of what
 * keeping the input would have bought you, at a fraction of the storage.
 *
 * Signed the same way as the audit bundle (`activity/audit-log.ts`), and for
 * the same reason: the entries are individually signed by their authors
 * already, so what the service's signature adds is the COMPLETENESS claim —
 * this is the whole record, in order, with nothing dropped.
 */

import { createHash } from "node:crypto";
import { canonicalJSON, signTagged, toB64Url, nkeys } from "../sdk.js";

type KeyPair = ReturnType<typeof nkeys.createUser>;

export const DOSSIER_SIG_PREFIX = "agentmesh-room-dossier-v1\n";

export type FileRole = "input" | "interim" | "output";

/** One record entry, flattened for storage. Deliberately close to the wire: a
 *  dossier is read by whoever has it, years later, with no SDK to hand. */
export interface DossierEntry {
  seq: number;
  ts: string;
  from: string;
  type: string;
  body?: string;
  member?: string;
  artifact?: {
    name: string;
    version: string;
    ref: string;
    digest: string;
    size?: number;
    /** The role the announcing member declared (EXT-5 §5.3), carried as
     *  written. Feeds `roleOf` where no EXT-9 record speaks about the file. */
    role?: string;
  };
}

export interface DossierFile {
  ref: string;
  name: string;
  version: string;
  digest: string;
  media_type: string | null;
  size: number;
  attached_by: string;
  attached_at: string;
  origin: string | null;
  /** Set when the bytes were never in the room: they live at this location and
   *  the digest above is the attaching member's claim about them. A linked
   *  output never carries `data_b64`, by construction rather than by loss. */
  external: string | null;
  role: FileRole;
  /** Outputs only. Absent means the bytes were not kept — the digest above is
   *  what remains, and it is enough to identify a copy found elsewhere. */
  data_b64?: string;
}

export interface RoomDossier {
  manifest: {
    format: "agentmesh-room-dossier-v1";
    room_id: string;
    room_name: string | null;
    creator: string;
    operator: string | null;
    created_at: string;
    closed_at: string;
    /** Why the room ended: "reclaimed by creator", "idle 4d", … */
    why: string;
    /** What this document is and is not, stated IN it, because a dossier
     *  outlives every page that would have explained it. */
    capture: "the room's full record; bytes for accepted outputs only, digests for everything else";
    entries: number;
    entries_sha256: string;
    files: number;
    outputs: number;
    files_sha256: string;
    signer_pub: string;
    sig: string;
  };
  record: DossierEntry[];
  files: DossierFile[];
}

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** `DELIVERABLE · revision · @ v2 · ref: …` */
const CLAIM = /^DELIVERABLE\s*·\s*([a-z][a-z-]*)\s*·\s*@\s*(\S+?)(?:\s*·\s*ref:\s*(\S+))?\s*$/i;
/** `ACCEPTED · deliverable: revision @ v2` */
const ACCEPT = /^ACCEPTED\s*·\s*deliverable:\s*([a-z][a-z-]*)\s*@\s*(\S+)/i;
/** `REJECTED · deliverable: draft @ v1` */
const REJECT = /^REJECTED\s*·\s*deliverable:\s*([a-z][a-z-]*)\s*@\s*(\S+)/i;
const FIELD = (body: string, name: string): string | null => {
  const m = body.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return m ? m[1]!.trim() : null;
};

export type DeliverableRecord =
  | { record: "DELIVERABLE"; name: string; version: string; ref: string | null; against: string | null }
  | { record: "ACCEPTED"; name: string; version: string }
  | { record: "REJECTED"; name: string; version: string; reason: string | null };

/**
 * Recognize one EXT-9 record, or null for anything else.
 *
 * FIRST LINE ONLY, which is normative (EXT-9 §4) rather than a shortcut. It is
 * what makes quoting a record safe: without it, an agent repeating someone
 * else's claim back to them would post that claim a second time under its own
 * signature. It is also what keeps prose inert — a reader that inferred job
 * state from conversation would be guessing, and a guess that silently
 * satisfies a requirement is worse than having no requirement.
 *
 * BROWSER TWIN: `app/src/files.ts`. Both are pinned by
 * `conformance/deliverable-records.json`.
 */
export function recognizeRecord(body: string | null | undefined): DeliverableRecord | null {
  if (!body) return null;
  const head = body.split("\n")[0]!.trim();
  const c = head.match(CLAIM);
  if (c) return { record: "DELIVERABLE", name: c[1]!, version: c[2]!, ref: c[3] ?? null, against: FIELD(body, "against") };
  const a = head.match(ACCEPT);
  if (a) return { record: "ACCEPTED", name: a[1]!, version: a[2]! };
  const r = head.match(REJECT);
  if (r) return { record: "REJECTED", name: r[1]!, version: r[2]!, reason: FIELD(body, "reason") };
  return null;
}

const key = (name: string, version: string): string => `${name.toLowerCase()}@${version}`;
const stem = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,8}$/, "");

/**
 * Which files are outputs, from what the room said.
 *
 * BROWSER TWIN: `app/src/files.ts` computes the same three roles for the files
 * panel, and the two must agree — a file the panel calls Accepted and the
 * dossier calls interim would mean the thing on screen is not the thing that
 * was kept. They are separate because one runs in a Node service and the other
 * in a browser bundle with no shared package between them; if a third surface
 * ever needs this, it earns a fixture like `conformance/rooms-entry.json`.
 */
export function roleOf(
  files: Array<{ ref: string; name: string; version: string }>,
  record: Array<{ type: string; body?: string; artifact?: { ref?: string; role?: string } }>,
): Map<string, FileRole> {
  const byRef = new Map<string, { deliverable: string; version: string }>();
  const byName = new Map<string, { deliverable: string; version: string }>();
  const accepted = new Set<string>();
  // The everyday layer (EXT-5 §5.3): what the announcing member SAID the file
  // is. Last announcement wins per ref — a re-attach that re-declares is the
  // member updating their own claim.
  const announced = new Map<string, FileRole>();

  for (const en of record) {
    if (en.type === "artifact") {
      const r = en.artifact?.role;
      if (en.artifact?.ref && (r === "input" || r === "interim" || r === "output")) {
        announced.set(en.artifact.ref, r);
      }
      continue;
    }
    if (en.type !== "say") continue;
    const rec = recognizeRecord(en.body);
    if (!rec) continue;
    if (rec.record === "DELIVERABLE") {
      const claim = { deliverable: rec.name, version: rec.version };
      if (rec.ref) byRef.set(rec.ref, claim);
      byName.set(key(rec.name, rec.version), claim);
    } else if (rec.record === "ACCEPTED") {
      accepted.add(key(rec.name, rec.version));
    }
    // REJECTED changes no role: the file WAS claimed, so it stays interim.
    // Demoting it to `input` would file a refused draft next to a contributed
    // reference, which is a different thing entirely.
  }

  const out = new Map<string, FileRole>();
  for (const f of files) {
    // Ref first, name second: a ref names one object exactly, a name and version
    // is a description that two files can answer to.
    const claim = byRef.get(f.ref) ?? byName.get(key(f.name, f.version)) ?? byName.get(key(stem(f.name), f.version));
    // EXT-9 governs where it speaks: a file somebody formally claimed follows
    // the claim's fate, and an announcement mark cannot promote past it. Where
    // EXT-9 is silent, the member's own declared role decides — that is the
    // everyday hand-over path for rooms that never run formal deliverables —
    // and a file nobody said anything about defaults to input, as it always
    // has.
    out.set(
      f.ref,
      claim
        ? accepted.has(key(claim.deliverable, claim.version)) ? "output" : "interim"
        : announced.get(f.ref) ?? "input",
    );
  }
  return out;
}

export interface BuildDossierInput {
  room_id: string;
  room_name: string | null;
  creator: string;
  operator: string | null;
  created_at: string;
  closed_at: string;
  why: string;
  record: DossierEntry[];
  files: Array<Omit<DossierFile, "role" | "data_b64">>;
  /** Bytes for a file, or null when they are gone. Called for outputs only. */
  readBytes: (ref: string) => Promise<Uint8Array | null>;
  signer: KeyPair;
}

export async function buildDossier(input: BuildDossierInput): Promise<RoomDossier> {
  const roles = roleOf(input.files, input.record);

  const files: DossierFile[] = [];
  for (const f of input.files) {
    const role = roles.get(f.ref) ?? "input";
    const entry: DossierFile = { ...f, role };
    // A linked artifact has no bytes here to keep. The location and the digest
    // ARE the record of it, and they are what a later reader needs to go and
    // check whatever they find at the other end.
    if (role === "output" && !f.external) {
      const bytes = await input.readBytes(f.ref);
      // A missing output is recorded as an output with no bytes rather than
      // demoted or dropped: the room DID accept it, and a dossier that quietly
      // changed that to fit what it could still read would be rewriting history
      // to match its storage.
      if (bytes) entry.data_b64 = Buffer.from(bytes).toString("base64");
    }
    files.push(entry);
  }

  // Each covered as its canonical JSON joined by newlines — the same scheme the
  // audit bundle uses, so one verifier shape covers both.
  const entriesSha = sha256hex(input.record.map((e) => canonicalJSON(e)).join("\n"));
  const filesSha = sha256hex(files.map((f) => canonicalJSON(f)).join("\n"));

  const unsigned = {
    format: "agentmesh-room-dossier-v1" as const,
    room_id: input.room_id,
    room_name: input.room_name,
    creator: input.creator,
    operator: input.operator,
    created_at: input.created_at,
    closed_at: input.closed_at,
    why: input.why,
    capture: "the room's full record; bytes for accepted outputs only, digests for everything else" as const,
    entries: input.record.length,
    entries_sha256: entriesSha,
    files: files.length,
    outputs: files.filter((f) => f.role === "output").length,
    files_sha256: filesSha,
    signer_pub: input.signer.getPublicKey(),
  };
  const sig = toB64Url(signTagged(input.signer, DOSSIER_SIG_PREFIX, canonicalJSON(unsigned)));
  return { manifest: { ...unsigned, sig }, record: input.record, files };
}

/**
 * Check a dossier without the mesh, an account, or a network.
 *
 * Returns the reasons it fails, empty when it holds. Three separate claims get
 * checked and they fail differently: the signature says the manifest is the
 * service's, the two digests say the record and file list are the ones it
 * signed, and each file's own digest says its bytes are the bytes.
 */
export function verifyDossier(
  d: RoomDossier,
  verify: (pub: string, prefix: string, msg: string, sig: string) => boolean,
): string[] {
  const bad: string[] = [];
  const { sig, ...unsigned } = d.manifest;
  if (!verify(d.manifest.signer_pub, DOSSIER_SIG_PREFIX, canonicalJSON(unsigned), sig)) {
    bad.push("the manifest signature does not verify against signer_pub");
  }
  if (sha256hex(d.record.map((e) => canonicalJSON(e)).join("\n")) !== d.manifest.entries_sha256) {
    bad.push("the record does not match entries_sha256");
  }
  if (sha256hex(d.files.map((f) => canonicalJSON(f)).join("\n")) !== d.manifest.files_sha256) {
    bad.push("the file list does not match files_sha256");
  }
  for (const f of d.files) {
    if (!f.data_b64) continue;
    const got = "sha256:" + createHash("sha256").update(Buffer.from(f.data_b64, "base64")).digest("hex");
    if (got !== f.digest) bad.push(`${f.name} @ ${f.version}: bytes hash to ${got}, not ${f.digest}`);
  }
  return bad;
}
