// The job manifest (job-manifest-v1), asserted against
// conformance/job-manifest.json.
//
// Like signature-tags.test.ts, this file holds the SDK to pinned bytes the
// TWO implementations must agree on: the prefix, the canonical JSON the
// signature covers, a real Ed25519 signature over prefix + canonical, the
// reason given for each invalid case, and the reuse count for the pinned
// prior/revision pair. THE FIXTURE IS THE AUTHORITY: when something here
// fails, fix src/job-manifest.ts to agree with the fixture — never the
// fixture to agree with the code. (Regenerate it only with a deliberate
// change, via regen-job-manifest-fixture.mts.)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import { canonicalJSON, fromB64Url, keyPairFromSeed } from "../../src/internal/identity.js";
import {
  JOB_MANIFEST_FORMAT,
  JOB_MANIFEST_SIG_PREFIX,
  canonicalJobManifestJSON,
  jobManifestReuse,
  jobManifestReuseClaimHolds,
  signJobManifest,
  validateJobManifest,
  verifyJobManifest,
  type JobManifest,
  type JobManifestReused,
} from "../../src/job-manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, "..", "..", "..", "conformance", "job-manifest.json");

interface InvalidCase {
  case: string;
  document: unknown;
  expected_agent?: string;
  reason: string;
  member: string;
}
interface Fixture {
  identities: { sender_seed: string; sender: string; recipient: string };
  job_manifest: { format: string; signed_bytes_prefix: string; canonical: string; signed: JobManifest };
  reuse: { prior: JobManifest; revision_canonical: string; revision: JobManifest; expected: JobManifestReused };
  invalid: { cases: InvalidCase[] };
}
const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const enc = new TextEncoder();

describe("job-manifest-v1 — the pinned first delivery", () => {
  const block = fixture.job_manifest;

  it("pins the format and the prefix", () => {
    expect(block.format).toBe(JOB_MANIFEST_FORMAT);
    expect(block.signed_bytes_prefix).toBe(JOB_MANIFEST_SIG_PREFIX);
    expect(block.signed.format).toBe(JOB_MANIFEST_FORMAT);
  });

  it("reproduces the canonical bytes from the signed document", () => {
    expect(canonicalJobManifestJSON(block.signed)).toBe(block.canonical);
    const { sig: _omit, ...rest } = block.signed;
    expect(canonicalJSON(rest)).toBe(block.canonical);
  });

  it("the sig covers prefix + canonical and nothing else", () => {
    const vpub = nkeys.fromPublic(fixture.identities.sender);
    const sig = fromB64Url(block.signed.sig);
    expect(vpub.verify(enc.encode(block.signed_bytes_prefix + block.canonical), sig)).toBe(true);
    expect(vpub.verify(enc.encode(block.canonical), sig)).toBe(false);
  });

  it("validates and verifies, bound to the pinned agent", () => {
    expect(validateJobManifest(block.signed)).toEqual({ ok: true });
    expect(verifyJobManifest(block.signed)).toEqual({ ok: true });
    expect(verifyJobManifest(block.signed, fixture.identities.sender)).toEqual({ ok: true });
    expect(block.signed.agent).toBe(fixture.identities.sender);
  });

  it("the SDK signer reproduces the pinned signature exactly from the seed (deterministic Ed25519)", () => {
    const { sig: _omit, agent: _agent, ...unsigned } = block.signed;
    expect(signJobManifest(unsigned, fixture.identities.sender_seed)).toEqual(block.signed);
    expect(signJobManifest(unsigned, keyPairFromSeed(fixture.identities.sender_seed))).toEqual(block.signed);
  });

  it("refuses to attribute a signature to a key other than the signer's", () => {
    const { sig: _omit, ...unsigned } = block.signed;
    expect(() => signJobManifest({ ...unsigned, agent: fixture.identities.recipient }, fixture.identities.sender_seed)).toThrow(
      /IDENTITY_MISMATCH|not the signing key/,
    );
  });
});

describe("job-manifest-v1 — the invalid cases give the pinned reason", () => {
  for (const row of fixture.invalid.cases) {
    it(row.case, () => {
      const v = verifyJobManifest(row.document, row.expected_agent);
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect({ reason: v.reason, member: v.member }).toEqual({ reason: row.reason, member: row.member });
      if (row.reason === "malformed" || row.reason === "wrong_format") {
        const shape = validateJobManifest(row.document);
        expect(shape.ok).toBe(false);
        if (shape.ok) return;
        expect({ reason: shape.reason, member: shape.member }).toEqual({ reason: row.reason, member: row.member });
      } else {
        // bad_signature and agent_mismatch are sound documents: shape passes.
        expect(validateJobManifest(row.document)).toEqual({ ok: true });
      }
    });
  }

  it("covers each reason at least once", () => {
    const reasons = new Set(fixture.invalid.cases.map((c) => c.reason));
    for (const want of ["wrong_format", "malformed", "bad_signature", "agent_mismatch"]) {
      expect(reasons.has(want), want).toBe(true);
    }
  });
});

describe("job-manifest-v1 — the pinned prior/revision pair", () => {
  const { prior, revision, revision_canonical, expected } = fixture.reuse;

  it("prior is the pinned first delivery, byte for byte", () => {
    expect(prior).toEqual(fixture.job_manifest.signed);
  });

  it("the revision reproduces its canonical bytes and verifies as the same agent", () => {
    expect(canonicalJobManifestJSON(revision)).toBe(revision_canonical);
    expect(verifyJobManifest(revision, fixture.identities.sender)).toEqual({ ok: true });
    expect(revision.version).toBe(prior.version + 1);
    expect(revision.revises).toBe(prior.task_id);
    expect(revision.job).toBe(prior.job);
  });

  it("the SDK signer reproduces the revision's signature from the seed", () => {
    const { sig: _omit, agent: _agent, ...unsigned } = revision;
    expect(signJobManifest(unsigned, fixture.identities.sender_seed)).toEqual(revision);
  });

  it("computes the pinned reuse count: same name and step, same ref AND digest", () => {
    expect(jobManifestReuse(prior, revision)).toEqual(expected);
    expect(revision.reused).toEqual(expected);
  });

  it("a first delivery reuses nothing", () => {
    expect(jobManifestReuse(null, prior)).toEqual({ pieces: 0, of: prior.pieces.length });
    expect(jobManifestReuse(undefined, prior)).toEqual({ pieces: 0, of: prior.pieces.length });
  });

  it("the claim holds for both, and not when the bytes moved or the flags lie", () => {
    expect(jobManifestReuseClaimHolds(null, prior)).toBe(true);
    expect(jobManifestReuseClaimHolds(prior, revision)).toBe(true);
    // Same ref, different digest: not reused, so the claim of 1 no longer holds.
    const moved = structuredClone(revision);
    moved.pieces[0].digest = "sha256:" + "0".repeat(64);
    expect(jobManifestReuse(prior, moved)).toEqual({ pieces: 0, of: 2 });
    expect(jobManifestReuseClaimHolds(prior, moved)).toBe(false);
    // Same digest, different ref: not reused either — both must match.
    const rehomed = structuredClone(revision);
    rehomed.pieces[0].ref = "mesh:artifacts:elsewhere";
    expect(jobManifestReuse(prior, rehomed)).toEqual({ pieces: 0, of: 2 });
    // Right count, flags on the wrong pieces: the claim does not hold.
    const swapped = structuredClone(revision);
    swapped.pieces[0].reused = false;
    swapped.pieces[1].reused = true;
    expect(jobManifestReuse(prior, swapped)).toEqual(expected);
    expect(jobManifestReuseClaimHolds(prior, swapped)).toBe(false);
    // A prior that lacks the piece's name+step: new, not reused.
    const renamed = structuredClone(prior);
    renamed.pieces[0].step = "rewrite-the-story";
    expect(jobManifestReuse(renamed, revision)).toEqual({ pieces: 0, of: 2 });
  });
});
