/**
 * The three job doors (§5.7) from the asking side: `job.manifest`,
 * `job.quote`, `job.record`.
 *
 * Three things are being held here, and the middle one is the point:
 *
 *  1. a good answer parses into the declared shape and nothing else;
 *  2. the sentence every door gives BOTH to an unentitled asker and about a
 *     task it does not know comes back as a refusal, never as a thrown "not
 *     found" and never flattened into "no such task". A stranger holding a
 *     task id must learn nothing from that door, and a client that guessed on
 *     the caller's behalf would undo it;
 *  3. an answer that does not parse is refused whole, with the member named.
 *
 * The manifest the door hands over is the one pinned by
 * `conformance/job-manifest.json`, so this test and the Rust SDK's read the
 * same signed bytes. The sentences are pinned against the adapter's own source
 * at the bottom of this file: the doors are served there, so that file is the
 * authority for what they say.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  JOB_MANIFEST_DOOR,
  JOB_QUOTE_DOOR,
  JOB_QUOTE_FORMAT,
  JOB_RECORD_DOOR,
  JOB_RECORD_FORMAT,
  MANIFEST_UNREADABLE_REASON,
  NO_JOB_MANIFEST_REASON,
  NO_JOB_REASON,
  NO_REVISIONS_REASON,
  askJobManifest,
  askJobQuote,
  askJobRecord,
  parseJobManifestAnswer,
  parseJobQuoteAnswer,
  parseJobRecordAnswer,
  type JobDoorSource,
} from "../../src/job-doors.js";
import { MeshError, ErrorCode } from "../../src/types/errors.js";
import type { JobManifest } from "../../src/job-manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, "..", "..", "..", "conformance", "job-manifest.json");
const ADAPTER_PATH = join(here, "..", "..", "..", "conformance", "reference-adapter", "mesh-adapter.mjs");

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  job_manifest: { signed: JobManifest };
};
const SIGNED: JobManifest = fixture.job_manifest.signed;
const MANIFEST_REF = "mesh:artifacts:f2c1a0de";

/** A quote the way the door builds one: the named steps with their prices,
 *  the total, what is still included, and the offering's whole step list. */
const QUOTE = {
  quote: JOB_QUOTE_FORMAT,
  offering: "explainer",
  steps: [
    { id: "script", price: { amount_micro: 2_000_000, currency: "USD" } },
    { id: "voice", price: null },
  ],
  price: { amount_micro: 2_000_000, currency: "USD" },
  included_remaining: 0,
  window_ends_at: "2026-09-24T09:00:00.000Z",
  unknown_steps: ["storyboard"],
  all_steps: ["script", "voice", "render"],
  at: "2026-09-10T12:00:00.000Z",
};

/** A record the way the door builds one, with the three faults it was written
 *  for represented: a folder that is gone, pieces that could not be stored,
 *  and a harness that did not answer. */
const RECORD = {
  record: JOB_RECORD_FORMAT,
  task_id: "t-77",
  at: "2026-09-10T12:00:00.000Z",
  offering: "explainer",
  received_at: "2026-09-10T11:02:00.000Z",
  folder: { present: false, made_at: "2026-09-10T11:02:01.000Z" },
  pieces_json: { found: true, where: "the job folder", at: "2026-09-10T11:40:00.000Z" },
  collected: { count: 3, names: ["explainer.html", "beat-01.mp3", "beat-02.mp3"] },
  dropped: [{ name: "render.mp4", size_bytes: 91_000_000, why: "over the store's size cap" }],
  skipped: [{ name: "notes.txt", why: "" }],
  manifest: { filed: true, ref: MANIFEST_REF, version: 2 },
  reply: { sent: true, at: "2026-09-10T11:41:00.000Z", delivery: "3 pieces" },
  refusal: null,
  harness: { fault: "the harness ended with no output", output_chars: 0 },
  unknown: ["whether a reply was sent"],
  summary: "The job folder was made at 2026-09-10T11:02:01.000Z and is no longer on this host.",
};

/** A stand-in for the connected client, which records what was asked. */
function fakeDoor(answer: unknown) {
  const asked: Array<{ agentId: string; offering: string; input: unknown; timeout?: number }> = [];
  const client: JobDoorSource = {
    async request(agentId, offering, input, config) {
      asked.push({ agentId, offering, input, timeout: config?.timeout_ms });
      return { payload: { output: answer } };
    },
  };
  return { client, asked };
}

/** A client whose transport fails, which is the other half of the refusal
 *  story: a door that said no is a value, a door that never answered is not. */
const deadDoor: JobDoorSource = {
  async request() {
    throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "no response");
  },
};

const AGENT = "UAGENTAGENTAGENTAGENTAGENTAGENTAGENTAGENTAGENTAGENTAGENT";

describe("job.manifest", () => {
  it("parses the pinned signed manifest and its ref", () => {
    const answer = parseJobManifestAnswer({ manifest: SIGNED, manifest_ref: MANIFEST_REF });
    expect(answer.outcome).toBe("answered");
    if (answer.outcome !== "answered") return;
    expect(answer.manifest).toEqual(SIGNED);
    expect(answer.manifest_ref).toBe(MANIFEST_REF);
  });

  it("surfaces the one sentence for an unknown task and someone else's task as a refusal", () => {
    const answer = parseJobManifestAnswer({ manifest: null, reason: NO_JOB_MANIFEST_REASON });
    expect(answer).toEqual({
      outcome: "refused",
      refusal: { reason: NO_JOB_MANIFEST_REASON, unknownOrNotYours: true },
    });
  });

  it("marks the unreadable-record refusal as the different thing it is", () => {
    const answer = parseJobManifestAnswer({ manifest: null, reason: MANIFEST_UNREADABLE_REASON });
    expect(answer).toEqual({
      outcome: "refused",
      refusal: { reason: MANIFEST_UNREADABLE_REASON, unknownOrNotYours: false },
    });
  });

  it("refuses a refusal that says nothing", () => {
    const answer = parseJobManifestAnswer({ manifest: null });
    expect(answer.outcome).toBe("malformed");
    if (answer.outcome !== "malformed") return;
    expect(answer.fault.member).toBe("reason");
  });

  it("refuses a malformed manifest rather than half-parsing it", () => {
    const broken = { ...SIGNED, pieces: [{ ...SIGNED.pieces[0], digest: "sha256:nope" }] };
    const answer = parseJobManifestAnswer({ manifest: broken, manifest_ref: MANIFEST_REF });
    expect(answer.outcome).toBe("malformed");
    if (answer.outcome !== "malformed") return;
    expect(answer.fault.reason).toBe("malformed");
    expect(answer.fault.member).toBe("manifest.pieces[0].digest");
  });

  it("refuses a manifest whose signature does not verify", () => {
    const tampered = { ...SIGNED, offering: "something-else" };
    const answer = parseJobManifestAnswer({ manifest: tampered, manifest_ref: MANIFEST_REF });
    expect(answer.outcome).toBe("malformed");
    if (answer.outcome !== "malformed") return;
    expect(answer.fault.reason).toBe("bad_signature");
    expect(answer.fault.member).toBe("manifest.sig");
  });

  it("refuses a manifest signed by a key the caller did not expect", () => {
    const answer = parseJobManifestAnswer(
      { manifest: SIGNED, manifest_ref: MANIFEST_REF },
      AGENT,
    );
    expect(answer.outcome).toBe("malformed");
    if (answer.outcome !== "malformed") return;
    expect(answer.fault.reason).toBe("agent_mismatch");
  });

  it("refuses an answer with a manifest and no ref", () => {
    const answer = parseJobManifestAnswer({ manifest: SIGNED });
    expect(answer.outcome).toBe("malformed");
    if (answer.outcome !== "malformed") return;
    expect(answer.fault.member).toBe("manifest_ref");
  });

  it("asks the door by name, with the task id the door reads", async () => {
    const { client, asked } = fakeDoor({ manifest: SIGNED, manifest_ref: MANIFEST_REF });
    const answer = await askJobManifest(client, AGENT, "t-77");
    expect(answer.outcome).toBe("answered");
    expect(asked).toHaveLength(1);
    expect(asked[0].agentId).toBe(AGENT);
    expect(asked[0].offering).toBe(JOB_MANIFEST_DOOR);
    expect(asked[0].input).toEqual({ task_id: "t-77" });
    expect(asked[0].timeout).toBeGreaterThan(0);
  });

  it("refuses an empty task id here rather than sending it", async () => {
    const { client, asked } = fakeDoor({ manifest: null, reason: NO_JOB_MANIFEST_REASON });
    await expect(askJobManifest(client, AGENT, "")).rejects.toThrow(/task_id/);
    expect(asked).toHaveLength(0);
  });
});

describe("job.quote", () => {
  it("parses a quote into the declared shape", () => {
    const answer = parseJobQuoteAnswer(QUOTE);
    expect(answer.outcome).toBe("answered");
    if (answer.outcome !== "answered") return;
    expect(answer.quote.offering).toBe("explainer");
    expect(answer.quote.steps[1].price).toBeNull();
    expect(answer.quote.price).toEqual({ amount_micro: 2_000_000, currency: "USD" });
    expect(answer.quote.unknown_steps).toEqual(["storyboard"]);
  });

  it("carries a quote with no window and nothing unknown", () => {
    const answer = parseJobQuoteAnswer({ ...QUOTE, window_ends_at: null, unknown_steps: undefined });
    expect(answer.outcome).toBe("answered");
    if (answer.outcome !== "answered") return;
    expect(answer.quote.window_ends_at).toBeNull();
    expect(answer.quote.unknown_steps).toBeUndefined();
  });

  it("surfaces the identical refusal as a refusal", () => {
    expect(parseJobQuoteAnswer({ quote: null, reason: NO_JOB_REASON })).toEqual({
      outcome: "refused",
      refusal: { reason: NO_JOB_REASON, unknownOrNotYours: true },
    });
  });

  it("marks the no-revisions refusal as the different thing it is", () => {
    expect(parseJobQuoteAnswer({ quote: null, reason: NO_REVISIONS_REASON })).toEqual({
      outcome: "refused",
      refusal: { reason: NO_REVISIONS_REASON, unknownOrNotYours: false },
    });
  });

  it("refuses a document that names itself something else", () => {
    const answer = parseJobQuoteAnswer({ ...QUOTE, quote: "job-quote-v2" });
    expect(answer.outcome).toBe("malformed");
    if (answer.outcome !== "malformed") return;
    expect(answer.fault.reason).toBe("wrong_format");
    expect(answer.fault.member).toBe("quote");
  });

  it("refuses a price that is not one, and a step that is not one", () => {
    const noCurrency = parseJobQuoteAnswer({ ...QUOTE, price: { amount_micro: 5 } });
    expect(noCurrency.outcome).toBe("malformed");
    if (noCurrency.outcome === "malformed") expect(noCurrency.fault.member).toBe("price");

    const badStep = parseJobQuoteAnswer({
      ...QUOTE,
      steps: [{ id: "script", price: { amount_micro: -1, currency: "USD" } }],
    });
    expect(badStep.outcome).toBe("malformed");
    if (badStep.outcome === "malformed") expect(badStep.fault.member).toBe("steps[0].price");
  });

  it("refuses an at that is not an instant in UTC", () => {
    const answer = parseJobQuoteAnswer({ ...QUOTE, at: "2026-09-10T12:00:00+02:00" });
    expect(answer.outcome).toBe("malformed");
    if (answer.outcome !== "malformed") return;
    expect(answer.fault.member).toBe("at");
  });

  it("sends revises, and the steps and offering only when they were given", async () => {
    const bare = fakeDoor(QUOTE);
    await askJobQuote(bare.client, AGENT, { revises: "t-77" });
    expect(bare.asked[0].offering).toBe(JOB_QUOTE_DOOR);
    expect(bare.asked[0].input).toEqual({ revises: "t-77" });

    const full = fakeDoor(QUOTE);
    await askJobQuote(full.client, AGENT, {
      revises: "t-77",
      steps: ["script"],
      offering: "explainer",
    });
    expect(full.asked[0].input).toEqual({
      revises: "t-77",
      steps: ["script"],
      offering: "explainer",
    });
  });
});

describe("job.record", () => {
  it("parses a record into the declared shape", () => {
    const answer = parseJobRecordAnswer(RECORD);
    expect(answer.outcome).toBe("answered");
    if (answer.outcome !== "answered") return;
    expect(answer.record.folder).toEqual({ present: false, made_at: "2026-09-10T11:02:01.000Z" });
    expect(answer.record.collected?.count).toBe(3);
    expect(answer.record.dropped?.[0].size_bytes).toBe(91_000_000);
    expect(answer.record.harness?.fault).toMatch(/no output/);
    expect(answer.record.unknown).toEqual(["whether a reply was sent"]);
  });

  it("keeps an unrecorded reply as unrecorded, not as not sent", () => {
    const answer = parseJobRecordAnswer({
      ...RECORD,
      reply: { sent: null, at: null, delivery: null },
    });
    expect(answer.outcome).toBe("answered");
    if (answer.outcome !== "answered") return;
    expect(answer.record.reply.sent).toBeNull();
  });

  it("carries a task the node wrote nothing down about", () => {
    const answer = parseJobRecordAnswer({
      ...RECORD,
      offering: null,
      received_at: null,
      pieces_json: null,
      collected: null,
      dropped: null,
      skipped: null,
      manifest: { filed: false, ref: null, version: null },
      refusal: null,
      harness: null,
    });
    expect(answer.outcome).toBe("answered");
  });

  it("allows a collection that counts more than it names", () => {
    // The node caps the names it lists and does not cap the count, so a very
    // large delivery names fewer pieces than it counted.
    const answer = parseJobRecordAnswer({
      ...RECORD,
      collected: { count: 200, names: ["explainer.html"] },
    });
    expect(answer.outcome).toBe("answered");
  });

  it("surfaces the identical refusal as a refusal", () => {
    expect(parseJobRecordAnswer({ record: null, reason: NO_JOB_REASON })).toEqual({
      outcome: "refused",
      refusal: { reason: NO_JOB_REASON, unknownOrNotYours: true },
    });
  });

  it("refuses a document that names itself something else", () => {
    const answer = parseJobRecordAnswer({ ...RECORD, record: "job-record-v2" });
    expect(answer.outcome).toBe("malformed");
    if (answer.outcome !== "malformed") return;
    expect(answer.fault.reason).toBe("wrong_format");
  });

  it("refuses a folder, a reply and a dropped piece that are not the shape", () => {
    const folder = parseJobRecordAnswer({ ...RECORD, folder: { present: "no", made_at: null } });
    expect(folder.outcome).toBe("malformed");
    if (folder.outcome === "malformed") expect(folder.fault.member).toBe("folder");

    const reply = parseJobRecordAnswer({ ...RECORD, reply: { sent: "yes", at: null, delivery: null } });
    expect(reply.outcome).toBe("malformed");
    if (reply.outcome === "malformed") expect(reply.fault.member).toBe("reply");

    const dropped = parseJobRecordAnswer({ ...RECORD, dropped: [{ name: "render.mp4" }] });
    expect(dropped.outcome).toBe("malformed");
    if (dropped.outcome === "malformed") expect(dropped.fault.member).toBe("dropped[0].why");
  });

  it("refuses an answer that is not an object at all", () => {
    const answer = parseJobRecordAnswer("no job for that task at this agent");
    expect(answer.outcome).toBe("malformed");
    if (answer.outcome !== "malformed") return;
    expect(answer.fault.member).toBe("answer");
  });

  it("asks the door by name and hands the record back", async () => {
    const { client, asked } = fakeDoor(RECORD);
    const answer = await askJobRecord(client, AGENT, "t-77");
    expect(answer.outcome).toBe("answered");
    expect(asked[0].offering).toBe(JOB_RECORD_DOOR);
    expect(asked[0].input).toEqual({ task_id: "t-77" });
  });

  it("raises a transport failure instead of reporting it as a refusal", async () => {
    await expect(askJobRecord(deadDoor, AGENT, "t-77")).rejects.toBeInstanceOf(MeshError);
    await expect(askJobQuote(deadDoor, AGENT, { revises: "t-77" })).rejects.toBeInstanceOf(MeshError);
    await expect(askJobManifest(deadDoor, AGENT, "t-77")).rejects.toBeInstanceOf(MeshError);
  });
});

// The doors are served by the reference node, so its source is the authority
// for their names and for the sentences they refuse with. Skipped rather than
// failed when the SDK is checked out on its own, which is the same bargain the
// broker-dependent suites make.
describe.skipIf(!existsSync(ADAPTER_PATH))("the door names and sentences the node serves", () => {
  const adapter = existsSync(ADAPTER_PATH) ? readFileSync(ADAPTER_PATH, "utf8") : "";

  it("names the same three doors", () => {
    for (const door of [JOB_MANIFEST_DOOR, JOB_QUOTE_DOOR, JOB_RECORD_DOOR]) {
      expect(adapter).toContain(`"${door}"`);
    }
  });

  it("refuses with the same sentences", () => {
    for (const reason of [
      NO_JOB_MANIFEST_REASON,
      NO_JOB_REASON,
      MANIFEST_UNREADABLE_REASON,
      NO_REVISIONS_REASON,
    ]) {
      expect(adapter).toContain(reason);
    }
  });

  it("names the same two document formats", () => {
    expect(adapter).toContain(JOB_QUOTE_FORMAT);
    expect(adapter).toContain(JOB_RECORD_FORMAT);
  });
});
