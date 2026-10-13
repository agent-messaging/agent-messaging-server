/**
 * The three job doors (§5.7), from the asking side.
 *
 * A node that runs an agent serves three request doors about one unit of
 * work, and until now no SDK could open any of them: a caller had to build
 * the request by hand and read the answer by guess.
 *
 *  - `job.manifest` answers with the signed manifest of a task's delivery.
 *  - `job.quote` answers with what redoing named steps of a task would cost
 *    now, under the agent's declared revisions policy.
 *  - `job.record` answers with what the node wrote down about one task while
 *    it happened: whether a job folder was made, what was collected, dropped
 *    or skipped, what the harness did, whether a reply went out. It exists so
 *    that an agent running on somebody else's compute can be diagnosed by the
 *    customer, who has no shell on that host.
 *
 * THREE RULES SHAPE THIS MODULE.
 *
 * **A refusal is a value, not an exception.** Every one of the three doors
 * answers an unentitled asker and an unknown task with ONE sentence, and that
 * is deliberate: a stranger holding a task id must not be able to learn
 * whether it exists. A client that turned that sentence into a thrown "not
 * found" would report a fact the door refused to state. So the sentence comes
 * back as the answer it is, with `unknownOrNotYours` set, and the caller is
 * told plainly that the two cases are not distinguishable from out here.
 *
 * **A transport failure throws.** `request` rejects on a timeout, on no
 * responders, on a refusal at admission. Nothing here catches those, so
 * "the door said no" and "nobody answered" can never be confused: one is a
 * returned value, the other is a raised `MeshError`.
 *
 * **A malformed answer is refused whole.** The parsers check every member
 * before handing anything back, and a document that fails is returned as a
 * fault naming the member, never as a half-populated record. The fault type
 * is the job manifest's, because the vocabulary already fits: a document that
 * names itself something other than `job-quote-v1` or `job-record-v1` is
 * `wrong_format`, and everything else these parsers can find is `malformed`.
 *
 * The parsers are pure and exported on their own, so a caller holding an
 * answer from anywhere (a recorded envelope, a test fixture, an MCP tool)
 * reads it the same way a live `ask` does.
 */

import { MeshError, ErrorCode } from "./types/errors.js";
import {
  RFC3339_UTC_RE,
  verifyJobManifest,
  type JobManifest,
  type JobManifestFault,
} from "./job-manifest.js";

// ─── the doors, and the sentences they answer with ──────────────────────────

/** The offering name of the manifest door. */
export const JOB_MANIFEST_DOOR = "job.manifest";
/** The offering name of the quote door. */
export const JOB_QUOTE_DOOR = "job.quote";
/** The offering name of the record door. */
export const JOB_RECORD_DOOR = "job.record";

/** The one value a quote answer's `quote` member may hold. */
export const JOB_QUOTE_FORMAT = "job-quote-v1";
/** The one value a record answer's `record` member may hold. */
export const JOB_RECORD_FORMAT = "job-record-v1";

/** The manifest door's one answer for a task it does not know AND for a
 *  caller that is not that task's requester. The two are deliberately
 *  indistinguishable. */
export const NO_JOB_MANIFEST_REASON = "no job manifest for that task at this agent";
/** The quote and record doors' one answer for the same pair of cases. */
export const NO_JOB_REASON = "no job for that task at this agent";
/** The manifest door's other refusal: it knows the job and could not read
 *  what it filed. Distinguishable from the pair above, and worth telling an
 *  operator about, since it says a file went missing on that host. */
export const MANIFEST_UNREADABLE_REASON = "the record of that task could not be read";
/** The quote door's other refusal: the job is yours and the agent declares no
 *  revisions for that offering, so there is nothing to price. */
export const NO_REVISIONS_REASON = "this agent declares no revisions for that offering";

/** How long a job door is given to answer. These doors read files the node
 *  already wrote and never wake a model, so a slow answer means the host is
 *  in trouble rather than thinking. */
export const DEFAULT_JOB_DOOR_TIMEOUT_MS = 20_000;

// ─── what comes back ────────────────────────────────────────────────────────

/** A door's refusal, as the door said it. */
export interface JobDoorRefusal {
  /** The door's sentence, verbatim. */
  reason: string;
  /** True when `reason` is the sentence the door gives BOTH for a task it has
   *  no record of and for a caller that is not that task's requester. When it
   *  is true, which of the two happened is not knowable from here, and a
   *  caller must not report it as either one. */
  unknownOrNotYours: boolean;
}

/** What the `job.manifest` door answered. */
export type JobManifestAnswer =
  | { outcome: "answered"; manifest: JobManifest; manifest_ref: string }
  | { outcome: "refused"; refusal: JobDoorRefusal }
  | { outcome: "malformed"; fault: JobManifestFault };

/** An amount in micro-units of a currency, the way the node prices a
 *  revision: `amount_micro` whole and never negative. */
export interface JobQuotePrice {
  amount_micro: number;
  currency: string;
}

/** One step named in the ask, and what it costs on its own. `price` is null
 *  when the agent declares no price for that step, which is the ordinary case
 *  under a flat revision price. */
export interface JobQuoteStep {
  id: string;
  price: JobQuotePrice | null;
}

/** The `job-quote-v1` document: what redoing the named steps costs now. */
export interface JobQuote {
  quote: typeof JOB_QUOTE_FORMAT;
  /** The offering whose revisions policy was quoted under. */
  offering: string;
  /** The steps that were asked about, in the order they were asked. */
  steps: JobQuoteStep[];
  /** What the whole revision costs. Zero while an included revision remains
   *  inside the window, which is why `included_remaining` travels beside it. */
  price: JobQuotePrice;
  /** How many included revisions are left inside the window. */
  included_remaining: number;
  /** When the included window closes, or null when the agent declares no
   *  window. */
  window_ends_at: string | null;
  /** Steps that were asked about and that the offering does not declare.
   *  Absent when every named step was known. */
  unknown_steps?: string[];
  /** Every step the offering declares, so a caller can ask again with a name
   *  the agent knows. */
  all_steps: string[];
  /** When the quote was made (RFC 3339, UTC). */
  at: string;
}

/** What the `job.quote` door answered. */
export type JobQuoteAnswer =
  | { outcome: "answered"; quote: JobQuote }
  | { outcome: "refused"; refusal: JobDoorRefusal }
  | { outcome: "malformed"; fault: JobManifestFault };

/** Whether a job folder is on that host now, and when the node recorded
 *  making one. The pair matters: "never made" and "made and since gone" are
 *  different faults, and `made_at` null with `present` true means the task is
 *  older than the node's records. */
export interface JobRecordFolder {
  present: boolean;
  made_at: string | null;
}

/** Whether the harness left a `pieces.json`, and where. `where` is null when
 *  none was found. Any host path in it has been folded by the node before it
 *  left that machine. */
export interface JobRecordPiecesJson {
  found: boolean;
  where: string | null;
  at: string | null;
}

/** What was collected. `count` is the whole count and `names` is capped by
 *  the node, so a very large delivery has more collected than named here. */
export interface JobRecordCollected {
  count: number;
  names: string[];
}

/** A piece that did not make it onto the delivery, and why. `size_bytes` is
 *  present only where the node recorded a size. */
export interface JobRecordPieceOutcome {
  name: string;
  size_bytes?: number;
  why: string;
}

/** Whether a signed job manifest was filed for this task, and which one. When
 *  `filed` is true the manifest door will hand it to the same caller. */
export interface JobRecordManifest {
  filed: boolean;
  ref: string | null;
  version: number | null;
}

/** Whether a reply went out. `sent` null means the node has NO RECORD of a
 *  reply, which is not the same statement as "no reply was sent" and must
 *  never be reported as one. */
export interface JobRecordReply {
  sent: boolean | null;
  at: string | null;
  delivery: string | null;
}

/** The refusal the reply carried, when it was one. */
export interface JobRecordRefusal {
  code: string;
  message: string;
}

/** What the harness did. `fault` is present when it did not answer;
 *  `output_chars` when it did. The stderr tail the node also holds is
 *  deliberately not here: it is the operator's to read, because a harness can
 *  echo anything on its way out, including a key. */
export interface JobRecordHarness {
  fault?: string;
  output_chars?: number;
}

/** The `job-record-v1` document: what the node wrote down about one task,
 *  while it was happening. Anything the node did not write down is null and
 *  is named in `unknown`; silence never resolves to the flattering value. */
export interface JobRecord {
  record: typeof JOB_RECORD_FORMAT;
  task_id: string;
  /** When the answer was assembled (RFC 3339, UTC). */
  at: string;
  offering: string | null;
  received_at: string | null;
  folder: JobRecordFolder;
  pieces_json: JobRecordPiecesJson | null;
  collected: JobRecordCollected | null;
  dropped: JobRecordPieceOutcome[] | null;
  skipped: JobRecordPieceOutcome[] | null;
  manifest: JobRecordManifest;
  reply: JobRecordReply;
  refusal: JobRecordRefusal | null;
  harness: JobRecordHarness | null;
  /** What this node cannot say about this task, in words. */
  unknown: string[];
  /** The whole record as sentences, so a person does not have to assemble it
   *  from the members above. */
  summary: string;
}

/** What the `job.record` door answered. */
export type JobRecordAnswer =
  | { outcome: "answered"; record: JobRecord }
  | { outcome: "refused"; refusal: JobDoorRefusal }
  | { outcome: "malformed"; fault: JobManifestFault };

// ─── reading an answer ──────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}
function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function isNullOrString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}
function isPrice(v: unknown): v is JobQuotePrice {
  return isPlainObject(v) && isCount(v.amount_micro) && nonEmptyString(v.currency);
}

function malformed(member: string, message: string): JobManifestFault {
  return { reason: "malformed", member, message };
}
function wrongFormat(member: string, message: string): JobManifestFault {
  return { reason: "wrong_format", member, message };
}

/** The door said null and gave a sentence. `identical` is the sentence THAT
 *  door uses for both the unknown task and the caller who is not the
 *  requester, which is what `unknownOrNotYours` reports. */
function refusalOf(reason: string, identical: string): JobDoorRefusal {
  return { reason, unknownOrNotYours: reason === identical };
}

/** Every piece outcome in a record answer, or a fault naming the first bad
 *  one. `why` may be empty: the node writes down the reason it had, and an
 *  empty one is still the reason it had. */
function pieceOutcomes(
  v: unknown,
  member: string,
): { ok: true; value: JobRecordPieceOutcome[] | null } | { ok: false; fault: JobManifestFault } {
  if (v === null) return { ok: true, value: null };
  if (!Array.isArray(v)) {
    return { ok: false, fault: malformed(member, `${member}, when present, is an array or null`) };
  }
  for (let i = 0; i < v.length; i++) {
    const entry: unknown = v[i];
    const at = `${member}[${i}]`;
    if (!isPlainObject(entry)) return { ok: false, fault: malformed(at, "each entry is an object") };
    if (!nonEmptyString(entry.name)) {
      return { ok: false, fault: malformed(`${at}.name`, "name is required") };
    }
    if (typeof entry.why !== "string") {
      return { ok: false, fault: malformed(`${at}.why`, "why is a sentence") };
    }
    if (entry.size_bytes !== undefined && !isCount(entry.size_bytes)) {
      return {
        ok: false,
        fault: malformed(`${at}.size_bytes`, "size_bytes, when present, is a whole number of bytes"),
      };
    }
  }
  return { ok: true, value: v as JobRecordPieceOutcome[] };
}

/**
 * Read a `job.manifest` answer.
 *
 * `expectedAgent` is passed through to `verifyJobManifest`: give it the agent
 * you asked when you want the manifest held to that key, and leave it out when
 * the agent may legitimately hand over a manifest another key signed.
 *
 * The signature is checked here rather than left to the caller, because a
 * manifest that does not verify is not a weaker answer, it is a different
 * document from the one the agent signed.
 */
export function parseJobManifestAnswer(
  answer: unknown,
  expectedAgent?: string,
): JobManifestAnswer {
  if (!isPlainObject(answer)) {
    return { outcome: "malformed", fault: malformed("answer", "a job.manifest answer is an object") };
  }
  const doc = answer.manifest;
  if (doc === undefined) {
    return {
      outcome: "malformed",
      fault: malformed("manifest", "an answer carries a manifest or null"),
    };
  }
  if (doc === null) {
    if (!nonEmptyString(answer.reason)) {
      return { outcome: "malformed", fault: malformed("reason", "a refused manifest says why") };
    }
    return { outcome: "refused", refusal: refusalOf(answer.reason, NO_JOB_MANIFEST_REASON) };
  }
  const verdict = verifyJobManifest(doc, expectedAgent);
  if (!verdict.ok) {
    // The member is reported as a path into the ANSWER, so a reader who has
    // the answer in front of them can find the member the fault is about.
    return {
      outcome: "malformed",
      fault: { reason: verdict.reason, member: `manifest.${verdict.member}`, message: verdict.message },
    };
  }
  if (!nonEmptyString(answer.manifest_ref)) {
    return {
      outcome: "malformed",
      fault: malformed("manifest_ref", "manifest_ref says where the filed manifest lives"),
    };
  }
  return { outcome: "answered", manifest: doc as JobManifest, manifest_ref: answer.manifest_ref };
}

/** Read a `job.quote` answer. The answered document IS the answer object: the
 *  door puts the quote's members at the top level rather than nesting them. */
export function parseJobQuoteAnswer(answer: unknown): JobQuoteAnswer {
  if (!isPlainObject(answer)) {
    return { outcome: "malformed", fault: malformed("answer", "a job.quote answer is an object") };
  }
  const format = answer.quote;
  if (format === undefined) {
    return { outcome: "malformed", fault: malformed("quote", "an answer carries a quote or null") };
  }
  if (format === null) {
    if (!nonEmptyString(answer.reason)) {
      return { outcome: "malformed", fault: malformed("reason", "a refused quote says why") };
    }
    return { outcome: "refused", refusal: refusalOf(answer.reason, NO_JOB_REASON) };
  }
  if (format !== JOB_QUOTE_FORMAT) {
    return { outcome: "malformed", fault: wrongFormat("quote", `quote must be "${JOB_QUOTE_FORMAT}"`) };
  }
  if (!nonEmptyString(answer.offering)) {
    return { outcome: "malformed", fault: malformed("offering", "offering names what was quoted") };
  }
  if (!Array.isArray(answer.steps)) {
    return { outcome: "malformed", fault: malformed("steps", "steps is an array, empty when none were named") };
  }
  for (let i = 0; i < answer.steps.length; i++) {
    const step: unknown = answer.steps[i];
    const at = `steps[${i}]`;
    if (!isPlainObject(step)) {
      return { outcome: "malformed", fault: malformed(at, "each step is an object") };
    }
    if (!nonEmptyString(step.id)) {
      return { outcome: "malformed", fault: malformed(`${at}.id`, "id names the step") };
    }
    if (step.price !== null && !isPrice(step.price)) {
      return {
        outcome: "malformed",
        fault: malformed(`${at}.price`, "price is { amount_micro, currency } or null"),
      };
    }
  }
  if (!isPrice(answer.price)) {
    return { outcome: "malformed", fault: malformed("price", "price is { amount_micro, currency }") };
  }
  if (!isCount(answer.included_remaining)) {
    return {
      outcome: "malformed",
      fault: malformed("included_remaining", "included_remaining is a count of revisions still included"),
    };
  }
  if (answer.window_ends_at !== null && !nonEmptyString(answer.window_ends_at)) {
    return {
      outcome: "malformed",
      fault: malformed("window_ends_at", "window_ends_at is an instant or null"),
    };
  }
  if (answer.unknown_steps !== undefined) {
    if (!Array.isArray(answer.unknown_steps) || !answer.unknown_steps.every(nonEmptyString)) {
      return {
        outcome: "malformed",
        fault: malformed("unknown_steps", "unknown_steps, when present, is an array of step names"),
      };
    }
  }
  if (!Array.isArray(answer.all_steps) || !answer.all_steps.every(nonEmptyString)) {
    return {
      outcome: "malformed",
      fault: malformed("all_steps", "all_steps is the offering's declared steps"),
    };
  }
  // `at` is stamped by the answering node as it answers, so it is held to the
  // format. The instants COPIED from an older record are not: the node does
  // not police what it wrote down months ago, and neither does this.
  if (!nonEmptyString(answer.at) || !RFC3339_UTC_RE.test(answer.at)) {
    return { outcome: "malformed", fault: malformed("at", "at is an RFC 3339 instant in UTC") };
  }
  return { outcome: "answered", quote: answer as unknown as JobQuote };
}

/** Read a `job.record` answer. Like the quote, the answered document IS the
 *  answer object. */
export function parseJobRecordAnswer(answer: unknown): JobRecordAnswer {
  if (!isPlainObject(answer)) {
    return { outcome: "malformed", fault: malformed("answer", "a job.record answer is an object") };
  }
  const format = answer.record;
  if (format === undefined) {
    return { outcome: "malformed", fault: malformed("record", "an answer carries a record or null") };
  }
  if (format === null) {
    if (!nonEmptyString(answer.reason)) {
      return { outcome: "malformed", fault: malformed("reason", "a refused record says why") };
    }
    return { outcome: "refused", refusal: refusalOf(answer.reason, NO_JOB_REASON) };
  }
  if (format !== JOB_RECORD_FORMAT) {
    return {
      outcome: "malformed",
      fault: wrongFormat("record", `record must be "${JOB_RECORD_FORMAT}"`),
    };
  }
  if (!nonEmptyString(answer.task_id)) {
    return { outcome: "malformed", fault: malformed("task_id", "task_id names the task answered about") };
  }
  if (!nonEmptyString(answer.at) || !RFC3339_UTC_RE.test(answer.at)) {
    return { outcome: "malformed", fault: malformed("at", "at is an RFC 3339 instant in UTC") };
  }
  if (!isNullOrString(answer.offering)) {
    return { outcome: "malformed", fault: malformed("offering", "offering is a string or null") };
  }
  if (!isNullOrString(answer.received_at)) {
    return { outcome: "malformed", fault: malformed("received_at", "received_at is an instant or null") };
  }
  if (
    !isPlainObject(answer.folder) ||
    typeof answer.folder.present !== "boolean" ||
    !isNullOrString(answer.folder.made_at)
  ) {
    return { outcome: "malformed", fault: malformed("folder", "folder is { present, made_at }") };
  }
  if (answer.pieces_json !== null) {
    const pj = answer.pieces_json;
    if (
      !isPlainObject(pj) ||
      typeof pj.found !== "boolean" ||
      !isNullOrString(pj.where) ||
      !isNullOrString(pj.at)
    ) {
      return {
        outcome: "malformed",
        fault: malformed("pieces_json", "pieces_json is { found, where, at } or null"),
      };
    }
  }
  if (answer.collected !== null) {
    const c = answer.collected;
    // `count` is the whole count and `names` is capped by the node, so a
    // delivery larger than the cap names fewer than it counts. Held to
    // "count is at least what is named" rather than to equality.
    if (
      !isPlainObject(c) ||
      !isCount(c.count) ||
      !Array.isArray(c.names) ||
      !c.names.every((n: unknown) => typeof n === "string") ||
      c.count < c.names.length
    ) {
      return {
        outcome: "malformed",
        fault: malformed("collected", "collected is { count, names } or null, and count is at least what it names"),
      };
    }
  }
  const dropped = pieceOutcomes(answer.dropped, "dropped");
  if (!dropped.ok) return { outcome: "malformed", fault: dropped.fault };
  const skipped = pieceOutcomes(answer.skipped, "skipped");
  if (!skipped.ok) return { outcome: "malformed", fault: skipped.fault };
  const m = answer.manifest;
  if (
    !isPlainObject(m) ||
    typeof m.filed !== "boolean" ||
    !isNullOrString(m.ref) ||
    (m.version !== null && !isCount(m.version))
  ) {
    return { outcome: "malformed", fault: malformed("manifest", "manifest is { filed, ref, version }") };
  }
  const reply = answer.reply;
  if (
    !isPlainObject(reply) ||
    (reply.sent !== null && typeof reply.sent !== "boolean") ||
    !isNullOrString(reply.at) ||
    !isNullOrString(reply.delivery)
  ) {
    return { outcome: "malformed", fault: malformed("reply", "reply is { sent, at, delivery }") };
  }
  if (answer.refusal !== null) {
    const r = answer.refusal;
    if (!isPlainObject(r) || typeof r.code !== "string" || typeof r.message !== "string") {
      return {
        outcome: "malformed",
        fault: malformed("refusal", "refusal is { code, message } or null"),
      };
    }
  }
  if (answer.harness !== null) {
    const h = answer.harness;
    if (
      !isPlainObject(h) ||
      (h.fault !== undefined && typeof h.fault !== "string") ||
      (h.output_chars !== undefined && !isCount(h.output_chars))
    ) {
      return {
        outcome: "malformed",
        fault: malformed("harness", "harness is { fault?, output_chars? } or null"),
      };
    }
  }
  if (!Array.isArray(answer.unknown) || !answer.unknown.every((u: unknown) => typeof u === "string")) {
    return {
      outcome: "malformed",
      fault: malformed("unknown", "unknown lists what this node cannot say, in words"),
    };
  }
  if (typeof answer.summary !== "string") {
    return { outcome: "malformed", fault: malformed("summary", "summary is the record as sentences") };
  }
  return { outcome: "answered", record: answer as unknown as JobRecord };
}

// ─── asking ─────────────────────────────────────────────────────────────────

/** What the job doors need from a connected client: the §6.4 request.
 *  Structural, like `DescribeSource`, so a caller holding a transport and a
 *  test holding a stand-in both satisfy it. */
export interface JobDoorSource {
  request(
    agentId: string,
    offering: string,
    input: unknown,
    config?: { timeout_ms?: number },
  ): Promise<{ payload?: { output?: unknown } | null }>;
}

/** Options common to all three asks. */
export interface JobDoorOptions {
  timeoutMs?: number;
}

/** What the quote door is asked. */
export interface JobQuoteAsk {
  /** The task being revised. The door calls it `revises`, because a quote is
   *  priced against the completion it would replace. */
  revises: string;
  /** The steps to redo. Leaving it out asks what the offering's flat revision
   *  price is, where one is declared. */
  steps?: string[];
  /** Which offering's revisions policy to quote under. Left out, the node
   *  uses the offering it recorded for that job. */
  offering?: string;
}

function requireTaskId(taskId: unknown, member: string): string {
  // Refused here rather than sent. An empty id would come back as the door's
  // "unknown task or not yours" sentence, and a caller cannot tell its own
  // empty string from a real refusal once it has been through that door.
  if (!nonEmptyString(taskId)) {
    throw new MeshError(ErrorCode.INPUT_INVALID, `a job door needs a ${member} to answer about`, {
      retryable: false,
    });
  }
  return taskId;
}

/** The one wire call all three asks make. The answer rides on the respond
 *  payload's `output` (§6.4); the bare-payload fallback is for a responder
 *  that answers with the document itself. */
async function askDoor(
  client: JobDoorSource,
  agentId: string,
  door: string,
  input: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const result = await client.request(agentId, door, input, {
    timeout_ms: timeoutMs ?? DEFAULT_JOB_DOOR_TIMEOUT_MS,
  });
  return result?.payload?.output ?? result?.payload ?? {};
}

/**
 * Ask an agent for the signed manifest of one task (§5.7).
 *
 * Answered only to that task's requester. A caller who is not, and a task the
 * agent has no manifest for, get the same sentence back, surfaced as a
 * refusal with `unknownOrNotYours` true.
 *
 * Throws on a transport failure, never on a refusal.
 */
export async function askJobManifest(
  client: JobDoorSource,
  agentId: string,
  taskId: string,
  opts: JobDoorOptions & { expectAgent?: string } = {},
): Promise<JobManifestAnswer> {
  const answer = await askDoor(
    client,
    agentId,
    JOB_MANIFEST_DOOR,
    { task_id: requireTaskId(taskId, "task_id") },
    opts.timeoutMs,
  );
  return parseJobManifestAnswer(answer, opts.expectAgent);
}

/**
 * Ask an agent what redoing named steps of one task would cost now (§5.7),
 * under its declared revisions policy. Answered only to that task's requester,
 * with the same identical refusal as the other two doors.
 *
 * Throws on a transport failure, never on a refusal.
 */
export async function askJobQuote(
  client: JobDoorSource,
  agentId: string,
  ask: JobQuoteAsk,
  opts: JobDoorOptions = {},
): Promise<JobQuoteAnswer> {
  const input: Record<string, unknown> = { revises: requireTaskId(ask?.revises, "revises") };
  if (ask.steps !== undefined) input.steps = ask.steps;
  if (ask.offering !== undefined) input.offering = ask.offering;
  const answer = await askDoor(client, agentId, JOB_QUOTE_DOOR, input, opts.timeoutMs);
  return parseJobQuoteAnswer(answer);
}

/**
 * Ask an agent what its node wrote down about one task (§5.7): whether a job
 * folder was made, what was collected, dropped or skipped, what the harness
 * did, whether a reply went out.
 *
 * This is the door for diagnosing an agent that runs on somebody else's
 * compute, where there is no shell to open. Answered only to that task's
 * requester, with the same identical refusal as the other two doors.
 *
 * Throws on a transport failure, never on a refusal.
 */
export async function askJobRecord(
  client: JobDoorSource,
  agentId: string,
  taskId: string,
  opts: JobDoorOptions = {},
): Promise<JobRecordAnswer> {
  const answer = await askDoor(
    client,
    agentId,
    JOB_RECORD_DOOR,
    { task_id: requireTaskId(taskId, "task_id") },
    opts.timeoutMs,
  );
  return parseJobRecordAnswer(answer);
}
