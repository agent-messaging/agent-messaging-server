/**
 * Job manifests (`job-manifest-v1`) — the signed record of what an agent
 * delivered.
 *
 * A completion is an answer plus pieces: the files the work produced, each
 * named, tied to the step that made it, and pinned by ref and digest. The
 * manifest is the agent's own signed statement of that set. A first delivery
 * is version 1 and opens a job; a revision is a new completion (a new task)
 * that names the completion it revises, carries the same `job`, and counts
 * how many pieces it carried forward unchanged.
 *
 * Three properties carry the design:
 *
 *  - **The deliverer signs.** `agent` is the key that did the work, and `sig`
 *    is that key's signature over the tagged canonical document. A reader
 *    holding a manifest holds the agent's word for what it delivered, not the
 *    platform's.
 *  - **Reuse is computed, never trusted.** The `reused` member is a claim. The
 *    truth is the pair (prior manifest, this manifest): a piece is reused when
 *    the prior manifest has a piece of the same name and step with the same
 *    ref AND the same digest. `jobManifestReuse` computes it and
 *    `jobManifestReuseClaimHolds` checks the claim against it.
 *  - **The format is a member, and verification refuses any other.** A
 *    signature over some other document shape must never verify as a manifest,
 *    so `verifyJobManifest` checks `format` before it checks bytes.
 *
 * Shapes, the canonical bytes and a real signature are pinned by
 * `conformance/job-manifest.json`; the Rust SDK reads the same fixture.
 */

import { MeshError, ErrorCode } from "./types/errors.js";
import {
  canonicalJSON,
  signTagged,
  verifyTagged,
  toB64Url,
  fromB64Url,
  keyPairFromSeed,
  type KeyPair,
} from "./internal/identity.js";

/** The one value `format` may hold. A verifier refuses every other. */
export const JOB_MANIFEST_FORMAT = "job-manifest-v1";

/** The domain tag inside a job manifest's signed bytes: `sig` covers this
 *  prefix + the canonical JSON of the document excluding `sig`. The prefix
 *  exists only inside the signed bytes — it never appears in the document
 *  itself. Pinned by conformance/job-manifest.json. */
export const JOB_MANIFEST_SIG_PREFIX = "agentmesh-job-manifest-v1\n";

/** One delivered piece. `name` and `step` together name it across
 *  revisions; `ref` and `digest` say which bytes it is this time. */
export interface JobManifestPiece {
  name: string;
  /** The delivery step that produced it. */
  step: string;
  media_type: string;
  /** Where the bytes live (`mesh:artifacts:...`). */
  ref: string;
  /** Size in bytes. */
  size: number;
  /** `sha256:` + 64 lowercase hex. */
  digest: string;
  /** OPTIONAL. Names of the inputs this piece was produced from. */
  produced_from?: string[];
  /** OPTIONAL. The piece's place within the delivery: a relative path with
   *  forward slashes, no leading slash and no `..` segment
   *  (`explainer.html`, `clips/beat-02.mp3`), so a reader can lay the
   *  pieces out as the agent did. */
  path?: string;
  /** OPTIONAL. `"file"` or `"link"`. A link piece's bytes are one URL
   *  (http or https), and a reader shows it as an address rather than a
   *  download. Absent means file. */
  kind?: "file" | "link";
  /** Carried forward unchanged from the prior manifest (same ref, same
   *  digest). Always false on a first delivery. */
  reused: boolean;
}

/** How many of this manifest's pieces carry the same ref and digest as the
 *  prior manifest's piece of the same name and step. `of` is this manifest's
 *  piece count. */
export interface JobManifestReused {
  pieces: number;
  of: number;
}

export interface JobManifest {
  format: typeof JOB_MANIFEST_FORMAT;
  /** The task id of the job's first delivery; stable across revisions. */
  job: string;
  /** This completion's task id. */
  task_id: string;
  context_id: string | null;
  /** The task id of the completion this one revises; null on a first
   *  delivery. */
  revises: string | null;
  /** 1 for the first delivery, +1 per revision. */
  version: number;
  /** The delivering agent's public key — the signer. */
  agent: string;
  offering: string;
  /** RFC 3339, UTC (`Z`). */
  produced_at: string;
  pieces: JobManifestPiece[];
  reused: JobManifestReused;
  /** base64url Ed25519 over JOB_MANIFEST_SIG_PREFIX + the canonical document
   *  excluding `sig`, by `agent`. */
  sig: string;
}

/** What `signJobManifest` takes: the document without `sig`. `agent` may be
 *  left out (it is filled from the signing key) or given, in which case it
 *  must match the key. */
export type UnsignedJobManifest = Omit<JobManifest, "sig" | "agent"> & { agent?: string; sig?: string };

/** Why a manifest was refused. The strings are the cross-SDK vocabulary:
 *  conformance/job-manifest.json names the reason each implementation must
 *  give for each invalid case. */
export type JobManifestReason =
  /** `format` is not "job-manifest-v1". Checked before anything else. */
  | "wrong_format"
  /** A member has the wrong shape; `member` names it. */
  | "malformed"
  /** `sig` does not verify against `agent` over the tagged canonical bytes. */
  | "bad_signature"
  /** The verifier expected a particular agent and `agent` is a different key. */
  | "agent_mismatch";

export interface JobManifestFault {
  reason: JobManifestReason;
  /** The offending member, as a path (`version`, `pieces[0].digest`,
   *  `reused.of`). */
  member: string;
  message: string;
}

export type JobManifestVerdict = { ok: true } | ({ ok: false } & JobManifestFault);

const NKEY_RE = /^U[A-Z2-7]{55}$/;
/** RFC 3339 in UTC: the `Z` designator only, no offset form. Exported for the
 *  job doors, which hold their own node-stamped instants to the same shape;
 *  not part of the package's public surface. */
export const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function fault(reason: JobManifestReason, member: string, message: string): JobManifestVerdict {
  return { ok: false, reason, member, message };
}
function malformed(member: string, message: string): JobManifestVerdict {
  return fault("malformed", member, message);
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}
function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
/** A piece's place within the delivery: forward slashes, no leading slash, no
 *  backslash, no empty segment, no `..` segment. */
function isDeliveryPath(v: unknown): v is string {
  if (!nonEmptyString(v) || v.includes("\\")) return false;
  return v.split("/").every((segment) => segment !== "" && segment !== "..");
}

/**
 * Shape check of every member, with a typed reason. Signature is
 * `verifyJobManifest`'s job; this is the shape alone. The rules beyond
 * "each member has its type":
 *
 *  - version 1 revises nothing and its `job` is its own `task_id`; any later
 *    version names the task it revises, which is not itself;
 *  - a name and step names one piece — no two pieces share both;
 *  - `reused.of` is the piece count and `reused.pieces` is the number of
 *    pieces flagged `reused`, so the summary cannot disagree with the list it
 *    summarizes. Whether the flags are TRUE is `jobManifestReuseClaimHolds`'s
 *    question, which needs the prior manifest.
 */
export function validateJobManifest(doc: unknown): JobManifestVerdict {
  if (!isPlainObject(doc)) return malformed("document", "a job manifest is an object");
  const d = doc;
  if (d.format !== JOB_MANIFEST_FORMAT) {
    return fault("wrong_format", "format", `format must be "${JOB_MANIFEST_FORMAT}"`);
  }
  if (!nonEmptyString(d.job)) return malformed("job", "job is the task id of the job's first delivery");
  if (!nonEmptyString(d.task_id)) return malformed("task_id", "task_id is this completion's task id");
  if (d.context_id !== null && !nonEmptyString(d.context_id)) {
    return malformed("context_id", "context_id is a string or null");
  }
  if (d.revises !== null && !nonEmptyString(d.revises)) {
    return malformed("revises", "revises is the prior completion's task id or null");
  }
  if (typeof d.version !== "number" || !Number.isInteger(d.version) || d.version < 1) {
    return malformed("version", "version is an integer, 1 for the first delivery");
  }
  if (d.version === 1) {
    if (d.revises !== null) return malformed("revises", "the first delivery (version 1) revises nothing");
    if (d.job !== d.task_id) return malformed("job", "the first delivery's job is its own task id");
  } else {
    if (d.revises === null) return malformed("revises", "a revision names the task id it revises");
    if (d.revises === d.task_id) return malformed("revises", "a completion cannot revise itself");
  }
  if (!nonEmptyString(d.agent) || !NKEY_RE.test(d.agent)) {
    return malformed("agent", "agent is the delivering agent's public key (an agent nkey)");
  }
  if (!nonEmptyString(d.offering)) return malformed("offering", "offering is required");
  if (!nonEmptyString(d.produced_at) || !RFC3339_UTC_RE.test(d.produced_at)) {
    return malformed("produced_at", "produced_at is an RFC 3339 instant in UTC");
  }
  if (!Array.isArray(d.pieces) || d.pieces.length === 0) {
    return malformed("pieces", "pieces is a non-empty array — a delivery of nothing has no manifest");
  }
  const seen = new Set<string>();
  let flagged = 0;
  for (let i = 0; i < d.pieces.length; i++) {
    const p: unknown = d.pieces[i];
    const at = `pieces[${i}]`;
    if (!isPlainObject(p)) return malformed(at, "each piece is an object");
    if (!nonEmptyString(p.name)) return malformed(`${at}.name`, "name is required");
    if (!nonEmptyString(p.step)) return malformed(`${at}.step`, "step names the delivery step that produced it");
    if (!nonEmptyString(p.media_type)) return malformed(`${at}.media_type`, "media_type is required");
    if (!nonEmptyString(p.ref)) return malformed(`${at}.ref`, "ref says where the bytes live");
    if (!isCount(p.size)) return malformed(`${at}.size`, "size is a whole number of bytes");
    if (!nonEmptyString(p.digest) || !SHA256_DIGEST_RE.test(p.digest)) {
      return malformed(`${at}.digest`, "digest is \"sha256:\" followed by 64 lowercase hex digits");
    }
    if (p.produced_from !== undefined) {
      if (!Array.isArray(p.produced_from) || !p.produced_from.every(nonEmptyString)) {
        return malformed(`${at}.produced_from`, "produced_from, when present, is an array of input names");
      }
    }
    if (p.path !== undefined && !isDeliveryPath(p.path)) {
      return malformed(`${at}.path`, "path, when present, is a relative path with forward slashes and no .. segment");
    }
    if (p.kind !== undefined && p.kind !== "file" && p.kind !== "link") {
      return malformed(`${at}.kind`, "kind, when present, is \"file\" or \"link\"");
    }
    if (typeof p.reused !== "boolean") return malformed(`${at}.reused`, "reused is a boolean");
    const key = JSON.stringify([p.name, p.step]);
    if (seen.has(key)) return malformed(at, "a name and step names one piece; this one repeats an earlier piece");
    seen.add(key);
    if (p.reused) flagged++;
  }
  if (!isPlainObject(d.reused)) return malformed("reused", "reused is { pieces, of }");
  if (!isCount(d.reused.pieces)) return malformed("reused.pieces", "reused.pieces is a count");
  if (!isCount(d.reused.of)) return malformed("reused.of", "reused.of is a count");
  if (d.reused.of !== d.pieces.length) return malformed("reused.of", "reused.of counts this manifest's pieces");
  if (d.reused.pieces !== flagged) {
    return malformed("reused.pieces", "reused.pieces counts the pieces flagged reused");
  }
  if (!nonEmptyString(d.sig)) return malformed("sig", "sig is required");
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromB64Url(d.sig);
  } catch {
    return malformed("sig", "sig is base64url");
  }
  if (sigBytes.length !== 64) return malformed("sig", "sig is a 64-byte Ed25519 signature");
  return { ok: true };
}

/** The canonical JSON a manifest's `sig` covers (without the prefix). */
export function canonicalJobManifestJSON(doc: object): string {
  const { sig: _omit, ...rest } = doc as { sig?: string };
  return canonicalJSON(rest);
}

/**
 * Verify a signed manifest: shape, then (when asked) that `agent` is the
 * expected key, then the signature against `agent`. Refuses any document
 * whose `format` is not "job-manifest-v1" before looking at the signature.
 * Returns the verdict rather than throwing so a reader can act on the reason.
 */
export function verifyJobManifest(doc: unknown, expectedAgent?: string): JobManifestVerdict {
  const shape = validateJobManifest(doc);
  if (!shape.ok) return shape;
  const d = doc as JobManifest;
  if (expectedAgent !== undefined && d.agent !== expectedAgent) {
    return fault("agent_mismatch", "agent", `signed by ${d.agent}, not the expected ${expectedAgent}`);
  }
  // Validated above: sig is base64url and 64 bytes long.
  const sigBytes = fromB64Url(d.sig);
  if (!verifyTagged(d.agent, JOB_MANIFEST_SIG_PREFIX, canonicalJobManifestJSON(d), sigBytes)) {
    return fault("bad_signature", "sig", "sig does not verify against agent over the tagged canonical document");
  }
  return { ok: true };
}

/**
 * Sign a manifest as the delivering agent. Takes the agent's keypair or its
 * seed. Fills `agent` from the key; when the document already names an
 * `agent`, it must be that key (a manifest signed by one key and attributed
 * to another is refused here rather than discovered later by a verifier).
 * Throws `IDENTITY_MISMATCH` on that, `INVALID_ENVELOPE` when the result
 * fails `validateJobManifest`, with the fault in `details`.
 */
export function signJobManifest(doc: UnsignedJobManifest, agent: KeyPair | string): JobManifest {
  const kp = typeof agent === "string" ? keyPairFromSeed(agent) : agent;
  const publicKey = kp.getPublicKey();
  if (doc.agent !== undefined && doc.agent !== publicKey) {
    throw new MeshError(
      ErrorCode.IDENTITY_MISMATCH,
      `job manifest: agent ${doc.agent} is not the signing key ${publicKey}`,
      { retryable: false },
    );
  }
  const { sig: _drop, ...rest } = doc;
  const unsigned = { ...rest, agent: publicKey };
  const sig = toB64Url(signTagged(kp, JOB_MANIFEST_SIG_PREFIX, canonicalJSON(unsigned)));
  const signed = { ...unsigned, sig } as JobManifest;
  const verdict = validateJobManifest(signed);
  if (!verdict.ok) {
    throw new MeshError(ErrorCode.INVALID_ENVELOPE, `job manifest: ${verdict.member}: ${verdict.message}`, {
      retryable: false,
      details: { reason: verdict.reason, member: verdict.member },
    });
  }
  return signed;
}

/** The pieces the reuse computation reads. */
type Pieces = Pick<JobManifest, "pieces">;

/**
 * How many of `next`'s pieces are carried forward from `prior`: a piece is
 * reused when `prior` has a piece of the same `name` and `step` whose `ref`
 * AND `digest` both equal it. `of` is `next`'s piece count. With no prior
 * manifest (a first delivery) nothing is reused.
 */
export function jobManifestReuse(prior: Pieces | null | undefined, next: Pieces): JobManifestReused {
  return { pieces: reusedFlags(prior, next).filter(Boolean).length, of: next.pieces.length };
}

/** Per piece of `next`, whether it is reused from `prior` (see `jobManifestReuse`). */
function reusedFlags(prior: Pieces | null | undefined, next: Pieces): boolean[] {
  return next.pieces.map((p) => {
    if (!prior) return false;
    const before = prior.pieces.find((q) => q.name === p.name && q.step === p.step);
    return before !== undefined && before.ref === p.ref && before.digest === p.digest;
  });
}

/**
 * Does `next`'s own `reused` member match what `jobManifestReuse(prior, next)`
 * computes? Each piece's `reused` flag is held to the computation too, so a
 * manifest whose count is right but whose flags are on the wrong pieces does
 * not pass. Pass `prior` as null for a first delivery: the claim then holds
 * only when nothing is flagged.
 */
export function jobManifestReuseClaimHolds(
  prior: Pieces | null | undefined,
  next: Pick<JobManifest, "pieces" | "reused">,
): boolean {
  const computed = jobManifestReuse(prior, next);
  if (next.reused.pieces !== computed.pieces || next.reused.of !== computed.of) return false;
  const flags = reusedFlags(prior, next);
  return next.pieces.every((p, i) => p.reused === flags[i]);
}
