// Generates conformance/job-manifest.json — the cross-SDK fixture for the
// job-manifest-v1 record. Run from sdk-typescript/:
//
//   npx vite-node regen-job-manifest-fixture.mts
//
// Every signature in the fixture is minted here by the SDK's own signer from
// the published test seed (the one signature-tags.json, budget.json and
// inbound-protections.json already use), never typed by hand. Ed25519 is
// deterministic (RFC 8032), so the Rust SDK reproduces the same bytes from
// the same seed, and the test on each side holds the implementation to
// exactly these bytes. Before writing, the script checks its own output the
// way the tests will, so a tooling drift cannot masquerade as a fixture.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { canonicalJSON, keyPairFromSeed, signTagged, toB64Url } from "./src/internal/identity.js";
import {
  JOB_MANIFEST_FORMAT,
  JOB_MANIFEST_SIG_PREFIX,
  canonicalJobManifestJSON,
  jobManifestReuse,
  jobManifestReuseClaimHolds,
  signJobManifest,
  verifyJobManifest,
  type JobManifest,
  type UnsignedJobManifest,
} from "./src/job-manifest.js";

const OUT = "../conformance/job-manifest.json";

const identities = {
  sender_seed: "SUAEGDPNTWXACIF45CA23BUY36RIMWZXW5LEHSEOK2ONS5JWJ7PBC2EWBA",
  sender: "UBMBH4BK6EIHQFVMHLSABFSQXB3JXUFZOXVZQTIERO33AD4HHAI3D7QP",
  recipient: "UAKQRYZBYFOC65OQZVJ3QPCIERDTRNNZPMOJUYXC3DGPRCDWSKD4HV5A",
  comment:
    "The same published test vectors signature-tags.json, budget.json and inbound-protections.json use, deliberately: they are not real identities and control nothing, and reusing them keeps any new private-key-shaped string out of the repository. The sender is the delivering agent (the signer); the recipient is only ever the WRONG key here.",
};
const kp = keyPairFromSeed(identities.sender_seed);
if (kp.getPublicKey() !== identities.sender) throw new Error("seed does not derive the published sender key");

const sha256 = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

const JOB = "0198c002-0000-7000-8000-00000000d001";
const FIRST: UnsignedJobManifest = {
  format: JOB_MANIFEST_FORMAT,
  job: JOB,
  task_id: JOB,
  context_id: "0198c002-0000-7000-8000-00000000c0de",
  revises: null,
  version: 1,
  offering: "story-package",
  produced_at: "2026-09-08T09:00:00.000Z",
  pieces: [
    {
      name: "beat script",
      step: "write-the-story",
      media_type: "text/plain",
      ref: "mesh:artifacts:01J8Z2K9Q0BEAT00000000000001",
      size: 1234,
      digest: sha256("beat script, first delivery"),
      produced_from: ["brief"],
      path: "script/beats.txt",
      kind: "file",
      reused: false,
    },
    {
      name: "storyboard",
      step: "draw-the-boards",
      media_type: "image/png",
      ref: "mesh:artifacts:01J8Z2K9Q0BOARD0000000000001",
      size: 48213,
      digest: sha256("storyboard, first delivery"),
      produced_from: ["beat script"],
      path: "boards/storyboard.png",
      reused: false,
    },
  ],
  reused: { pieces: 0, of: 2 },
};
const first = signJobManifest(FIRST, kp);

const REVISION: UnsignedJobManifest = {
  format: JOB_MANIFEST_FORMAT,
  job: JOB,
  task_id: "0198c002-0000-7000-8000-00000000d002",
  context_id: FIRST.context_id,
  revises: JOB,
  version: 2,
  offering: "story-package",
  produced_at: "2026-09-08T11:30:00.000Z",
  pieces: [
    // Carried forward: same name and step, same ref, same digest (and the
    // same path and kind, spread from the first delivery's piece).
    { ...FIRST.pieces[0], reused: true },
    // Redrawn: same name and step, new bytes.
    {
      name: "storyboard",
      step: "draw-the-boards",
      media_type: "image/png",
      ref: "mesh:artifacts:01J8Z2K9Q0BOARD0000000000002",
      size: 51877,
      digest: sha256("storyboard, redrawn after review"),
      produced_from: ["beat script", "review notes"],
      path: "boards/storyboard.png",
      reused: false,
    },
  ],
  reused: { pieces: 1, of: 2 },
};
const revision = signJobManifest(REVISION, kp);

// ── self-check the way the tests will ───────────────────────────────────────
const expectOk = (doc: unknown, what: string) => {
  const v = verifyJobManifest(doc);
  if (!v.ok) throw new Error(`${what} does not verify: ${v.reason} ${v.member}: ${v.message}`);
};
expectOk(first, "first");
expectOk(revision, "revision");
const expected = jobManifestReuse(first, revision);
if (expected.pieces !== 1 || expected.of !== 2) throw new Error("reuse computation drifted");
if (!jobManifestReuseClaimHolds(null, first)) throw new Error("first delivery's claim must hold");
if (!jobManifestReuseClaimHolds(first, revision)) throw new Error("revision's claim must hold");

// ── invalid cases, each with the reason BOTH SDKs must give ─────────────────
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// Well-formed, really signed by the agent over the same prefix — and still
// refused, because the format member is not job-manifest-v1.
const otherFormat = { ...clone(first), format: "job-manifest-v2" } as Record<string, unknown>;
delete otherFormat.sig;
otherFormat.sig = toB64Url(signTagged(kp, JOB_MANIFEST_SIG_PREFIX, canonicalJSON(otherFormat)));

const tamperedDigest = clone(first);
const d0 = tamperedDigest.pieces[0].digest;
tamperedDigest.pieces[0].digest = d0.slice(0, -1) + (d0.endsWith("0") ? "1" : "0");

const agentSwapped = { ...clone(first), agent: identities.recipient };

const digestNotSha256 = clone(first);
digestNotSha256.pieces[0].digest = "sha256:notahash";

const summaryDisagrees = { ...clone(first), reused: { pieces: 2, of: 2 } };

const versionZero = { ...clone(first), version: 0 };

const firstThatRevises = { ...clone(first), revises: "0198c002-0000-7000-8000-00000000d000" };

const sigMissing = clone(first) as Record<string, unknown>;
delete sigMissing.sig;

const sigNotASignature = { ...clone(first), sig: "AAAA" };

const pathEscapes = clone(first);
pathEscapes.pieces[0].path = "../beats.txt";

const kindUnknown = clone(first);
(kindUnknown.pieces[0] as Record<string, unknown>).kind = "url";

interface InvalidCase {
  case: string;
  comment: string;
  document: unknown;
  expected_agent?: string;
  reason: string;
  member: string;
}
const invalid: InvalidCase[] = [
  {
    case: "wrong_format",
    comment:
      "Well-formed and REALLY signed by the agent over the job-manifest prefix, with format set to job-manifest-v2. A verifier refuses it on the format member before it looks at a byte of the signature: a signature can never make a document into a manifest.",
    document: otherFormat,
    reason: "wrong_format",
    member: "format",
  },
  {
    case: "tampered_digest",
    comment: "The pinned manifest with the last hex digit of pieces[0].digest flipped. Still a well-shaped digest; no longer what the agent signed.",
    document: tamperedDigest,
    reason: "bad_signature",
    member: "sig",
  },
  {
    case: "agent_swapped",
    comment: "The pinned manifest with `agent` replaced by the recipient key and the signature left as it was. The signature is the sender's, so it does not verify against the key the document names.",
    document: agentSwapped,
    reason: "bad_signature",
    member: "sig",
  },
  {
    case: "not_the_expected_agent",
    comment: "The pinned manifest, verified by a reader that expected the recipient to have delivered. The document is sound; it is the wrong agent's.",
    document: first,
    expected_agent: identities.recipient,
    reason: "agent_mismatch",
    member: "agent",
  },
  {
    case: "digest_not_sha256",
    comment: "digest must be \"sha256:\" followed by 64 lowercase hex digits.",
    document: digestNotSha256,
    reason: "malformed",
    member: "pieces[0].digest",
  },
  {
    case: "reused_summary_disagrees_with_the_list",
    comment: "reused.pieces claims 2 while no piece is flagged reused. The summary must count the flags; whether the flags are TRUE needs the prior manifest and is the reuse claim check's question, not the shape's.",
    document: summaryDisagrees,
    reason: "malformed",
    member: "reused.pieces",
  },
  {
    case: "version_zero",
    comment: "version is an integer starting at 1.",
    document: versionZero,
    reason: "malformed",
    member: "version",
  },
  {
    case: "first_delivery_that_revises",
    comment: "version 1 is the first delivery and revises nothing.",
    document: firstThatRevises,
    reason: "malformed",
    member: "revises",
  },
  {
    case: "sig_missing",
    comment: "No sig, no manifest.",
    document: sigMissing,
    reason: "malformed",
    member: "sig",
  },
  {
    case: "sig_not_a_signature",
    comment: "sig decodes (three bytes) but is not a 64-byte Ed25519 signature — a shape fault, not a verification failure.",
    document: sigNotASignature,
    reason: "malformed",
    member: "sig",
  },
  {
    case: "path_escapes",
    comment:
      "The pinned manifest with pieces[0].path set to \"../beats.txt\". A path that climbs out of the delivery is refused before any layout is attempted.",
    document: pathEscapes,
    reason: "malformed",
    member: "pieces[0].path",
  },
  {
    case: "kind_unknown",
    comment:
      "The pinned manifest with pieces[0].kind set to \"url\". The descriptor's output kinds are not the manifest's vocabulary; a manifest piece is a file or a link.",
    document: kindUnknown,
    reason: "malformed",
    member: "pieces[0].kind",
  },
];
for (const row of invalid) {
  const v = verifyJobManifest(row.document, row.expected_agent);
  if (v.ok) throw new Error(`invalid case ${row.case} verified`);
  if (v.reason !== row.reason || v.member !== row.member) {
    throw new Error(`invalid case ${row.case}: got ${v.reason} ${v.member}, wanted ${row.reason} ${row.member}`);
  }
}

const fixture = {
  comment:
    "Conformance fixture for the job manifest (format job-manifest-v1): the signed record of what an agent delivered for one completion of a job. The TS SDK (sdk-typescript/src/job-manifest.ts) and the Rust SDK (sdk-rust/src/job_manifest.rs) MUST both reproduce the canonical bytes and the signatures here from the same seed, verify them, give the pinned reason for each invalid case, and compute the pinned reuse count for the prior/revision pair. sig covers signed_bytes_prefix + canonicalJSON(document without sig) and NOTHING ELSE; the prefix never appears in the document; sig is base64url. THE FIXTURE IS THE AUTHORITY: when a test against it fails, fix the implementation, and when the fixture itself is believed wrong, regenerate it with sdk-typescript/regen-job-manifest-fixture.mts alongside the change that made it wrong.",
  version: 1,
  spec: "job-manifest-v1 (the delivering agent's signed record of a completion's pieces); signing scheme as SPEC.md 5.3 / conformance/signature-tags.json",
  identities,
  job_manifest: {
    comment:
      "The first delivery of a job: version 1, revises nothing, job is its own task_id, nothing reused. The agent (sender) signs. sig is base64url and covers signed_bytes_prefix + canonical. The first piece carries the optional path and kind, the second carries path alone; a piece without them is a file with no stated place, and a manifest without them is the same document it was before they existed.",
    format: JOB_MANIFEST_FORMAT,
    signed_bytes_prefix: JOB_MANIFEST_SIG_PREFIX,
    canonical: canonicalJobManifestJSON(first),
    signed: first,
  },
  reuse: {
    comment:
      "A revision of the manifest above: version 2, revises the first delivery's task_id, same job. Reuse is computed by matching pieces by name AND step, and a match is reused only when its ref AND digest both equal the prior's. Here the beat script is carried forward and the storyboard was redrawn, so 1 of 2. `prior` is byte for byte job_manifest.signed; a reader holding the pair computes `expected` and finds the revision's own reused member agrees. Each piece's reused flag must agree with the computation too.",
    prior: first,
    revision_canonical: canonicalJobManifestJSON(revision),
    revision,
    expected: expected,
  },
  invalid: {
    comment:
      "Each case names the reason and the member BOTH SDKs must give from verify (and, for malformed and wrong_format, from validate as well). `expected_agent`, when present, is the key the verifier was told to expect.",
    cases: invalid,
  },
  not_covered: {
    comment: "Boundaries, written down so nobody mistakes them for gaps.",
    items: [
      "Whether a ref resolves and its bytes hash to the digest is the artifact store's question; the manifest pins what the agent claimed, and the signature pins that the agent claimed it.",
      "Whether `revises` names a real earlier completion of the same job by the same agent is the platform's question (the completion ledger); the reuse computation is defined over any pair it is handed and does not check job or revises.",
      "Reuse is computed between two manifests only. A piece that reappears with the same bytes three versions later, having been dropped in between, is new again at that version.",
      "The manifest carries no price and no acceptance; those are the settlement's and the acceptance record's.",
    ],
  },
};

writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n");
console.log("wrote", OUT);
console.log("canonical:", fixture.job_manifest.canonical);
console.log("sig:", (first as JobManifest).sig);
