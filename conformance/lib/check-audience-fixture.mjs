#!/usr/bin/env node
// Checks conformance/audience.json (SPEC.md §5.7, messages for the person
// behind an agent) against itself and against the rules of §5.7, with node
// alone: no SDK, no mesh, nothing installed.
//
//   node conformance/lib/check-audience-fixture.mjs
//
// What it checks, in order:
//
//   1. The signing helper (envelope-vectors.mjs) reproduces the signed accept
//      in accept-signal.json, so a pass below is a statement about the fixture
//      and not about a broken helper.
//   2. The fixture's sender seed is its sender's key.
//   3. Every envelope's canonical bytes rebuild from the envelope and its
//      signature verifies.
//   4. Every tamper case (the mark stripped, flipped or added after signing)
//      fails verification, and the untouched control passes.
//   5. The readings, the receiver's routing table, the task manager's cases
//      and the sender's pre-flight agree with §5.7's rules, written out below
//      as small reference functions.
//   6. The frame cases equal inbound-protections.json's frames with the one
//      audience line added, so the two fixtures cannot drift apart.
//
// Every section must have cases, and the count of each is printed: a check
// that quietly skipped a section would pass while checking nothing.
//
// The reference functions are test code that states the rules once in a
// checkable form. They are no implementation to copy: an SDK, a node or a
// server implements §5.7 from the specification and reads this fixture in its
// own tests.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalEnvelope, idFromSeed, ENVELOPE_PREFIX, verifyEnvelope } from "./envelope-vectors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(HERE, "..", name), "utf8"));

const fixture = read("audience.json");
const acceptSignal = read("accept-signal.json");
const inbound = read("inbound-protections.json");

const problems = [];
const counts = {};
const count = (section) => { counts[section] = (counts[section] ?? 0) + 1; };
const fail = (where, what) => problems.push(`${where}: ${what}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── §5.7's rules, stated once ──────────────────────────────────────────────

/** How a receiver reads meta.audience: "agent", "person" or "malformed". */
function readAudience(meta) {
  if (meta === null || meta === undefined || !Object.hasOwn(meta, "audience")) return "agent";
  const a = meta.audience;
  if (typeof a !== "string") return "malformed";
  return a === "agent" ? "agent" : "person";
}

const CARRIERS = new Set(["request", "respond", "say", "say (replayed from the record)"]);
const NEVER_TO_A_HANDLER = new Set(["emit", "Task update"]);

/** Where a receiver that implements §5.7, and has a person, sends a message. */
function route({ type, audience, setting }) {
  const meta = audience === "absent" ? {} : { audience };
  const reading = readAudience(meta);
  if (reading === "malformed") return "refused";
  if (reading === "agent") return "handler";
  if (NEVER_TO_A_HANDLER.has(type)) return "dropped";
  if (!CARRIERS.has(type)) return "ignored";
  return setting === "on" ? "agent_note" : "person";
}

/** Whether the task manager applies a Task update with this meta. */
const taskManagerApplies = (meta) => readAudience(meta) === "agent";

/** The sending SDK's pre-flight for a message marked for a person. */
function preflight({ receivers, audience = "person", send_anyway }) {
  if (audience !== "person") return { result: "send" };
  const missing = receivers.filter((r) => r.declares !== true).map((r) => r.id);
  if (missing.length && !send_anyway) return { result: "AUDIENCE_NOT_SUPPORTED", details_receivers: missing };
  return { result: "send" };
}

// ── 1. the helper ──────────────────────────────────────────────────────────

const accept = acceptSignal.accept.envelope;
if (canonicalEnvelope(accept.signed) !== accept.canonical) fail("helper", "does not rebuild accept-signal.json's canonical bytes");
if (!verifyEnvelope(accept.signed)) fail("helper", "does not verify accept-signal.json's signed accept");
if (verifyEnvelope({ ...accept.signed, payload: { status: "tampered" } })) fail("helper", "verifies a tampered accept");
count("helper");

// ── 2. identities ──────────────────────────────────────────────────────────

if (idFromSeed(fixture.identities.sender_seed) !== fixture.identities.sender) fail("identities", "sender_seed is not the sender's key");
if (fixture.signed_bytes_prefix !== ENVELOPE_PREFIX) fail("identities", `signed_bytes_prefix is ${JSON.stringify(fixture.signed_bytes_prefix)}`);
count("identities");

// ── 3. envelopes ───────────────────────────────────────────────────────────

const envelopes = Object.entries(fixture.envelopes).filter(([k]) => k !== "comment");
for (const [name, v] of envelopes) {
  count("envelopes");
  if (canonicalEnvelope(v.signed) !== v.canonical) fail(`envelopes.${name}`, "canonical does not rebuild from the envelope");
  if (!verifyEnvelope(v.signed)) fail(`envelopes.${name}`, "signature does not verify");
  if (v.signed.from !== fixture.identities.sender) fail(`envelopes.${name}`, "is not signed by the fixture's sender");
  const reading = readAudience(v.signed.meta);
  if (name.startsWith("person_") && reading !== "person") fail(`envelopes.${name}`, `reads as ${reading}`);
  if (name.startsWith("agent_") && reading !== "agent") fail(`envelopes.${name}`, `reads as ${reading}`);
  if (reading === "person") {
    if (v.signed.budget !== undefined) fail(`envelopes.${name}`, "a message for a person carries a budget");
    if (v.signed.task_id !== undefined) fail(`envelopes.${name}`, "a message for a person carries a task_id");
    if (v.signed.payload?.offering !== undefined) fail(`envelopes.${name}`, "a message for a person names an offering");
    if (typeof v.signed.payload?.text !== "string") fail(`envelopes.${name}`, "the text for the person is not payload.text");
  }
}
const reply = fixture.envelopes.person_reply?.signed;
if (reply && (reply.type !== "respond" || !reply.in_reply_to || reply.payload?.status !== "completed")) {
  fail("envelopes.person_reply", "a person's reply is a bare respond with in_reply_to and status completed");
}

// ── 4. tamper ──────────────────────────────────────────────────────────────

function applyChange(envelope, { op, path, value }) {
  const copy = structuredClone(envelope);
  if (op === "none") return copy;
  const keys = path.split(".");
  const last = keys.pop();
  let at = copy;
  for (const k of keys) { at[k] ??= {}; at = at[k]; }
  if (op === "delete") delete at[last];
  else if (op === "set") at[last] = value;
  else throw new Error(`unknown op ${op}`);
  return copy;
}
for (const c of fixture.tamper.cases) {
  count("tamper");
  const source = fixture.envelopes[c.from]?.signed;
  if (!source) { fail(`tamper.${c.id}`, `no envelope ${c.from}`); continue; }
  const changed = applyChange(source, c);
  if (verifyEnvelope(changed) !== c.verifies) fail(`tamper.${c.id}`, `verifies=${!c.verifies}, the fixture says ${c.verifies}`);
}
if (!fixture.tamper.cases.some((c) => c.verifies === true)) fail("tamper", "no control case that MUST verify");

// ── 5. the rules ───────────────────────────────────────────────────────────

for (const c of fixture.readings.cases) {
  count("readings");
  const got = readAudience(c.meta);
  if (got !== c.reading) fail(`readings.${c.id}`, `reads as ${got}, the fixture says ${c.reading}`);
}
for (const kind of ["agent", "person", "malformed"]) {
  if (!fixture.readings.cases.some((c) => c.reading === kind)) fail("readings", `no case that reads as ${kind}`);
}

for (const c of fixture.receiver.cases) {
  count("receiver");
  const got = route(c);
  if (got !== c.outcome) fail(`receiver.${c.id}`, `routes to ${got}, the fixture says ${c.outcome}`);
  if (got !== "handler" && got !== "ignored") {
    for (const k of ["accept_signal", "task", "metered"]) if (c[k] !== false) fail(`receiver.${c.id}`, `${k} must be false for a message no handler gets`);
  }
}
for (const outcome of ["handler", "person", "agent_note", "refused", "dropped", "ignored"]) {
  if (!fixture.receiver.cases.some((c) => c.outcome === outcome)) fail("receiver", `no case with outcome ${outcome}`);
}

for (const c of fixture.inbox.cases) {
  count("inbox");
  const marked = c.entry_audience === "person";
  if (marked && c.setting === "off" && c.harness_sees_text !== false) fail(`inbox.${c.id}`, "the harness sees the text of a message for the person");
  if (marked && c.setting === "on" && c.harness_sees_frame_with_audience_line !== true) fail(`inbox.${c.id}`, "the harness gets the text without the audience line");
  if (marked && c.person_sees_text !== true) fail(`inbox.${c.id}`, "the person does not see a message meant for them");
}

for (const c of fixture.server.task_manager) {
  count("server.task_manager");
  const got = taskManagerApplies(c.meta);
  if (got !== c.applies) fail(`server.task_manager.${c.id}`, `applies=${got}, the fixture says ${c.applies}`);
}
for (const c of fixture.server.carriage) count("server.carriage");

for (const c of fixture.sender.preflight) {
  count("sender.preflight");
  const got = preflight(c);
  if (got.result !== c.result) fail(`sender.preflight.${c.id}`, `result ${got.result}, the fixture says ${c.result}`);
  if (got.details_receivers && !same(got.details_receivers, c.details_receivers)) {
    fail(`sender.preflight.${c.id}`, `names ${JSON.stringify(got.details_receivers)}, the fixture says ${JSON.stringify(c.details_receivers)}`);
  }
}

// ── 6. the frame ───────────────────────────────────────────────────────────

const line = fixture.frame.audience_line;
if (!/^audience: {2}person {2}\(/.test(line)) fail("frame", "the audience line does not start 'audience:  person  ('");
if (/-{3}|={3}/.test(line)) fail("frame", "the audience line contains a run a fence would treat as a marker");
for (const c of fixture.frame.cases) {
  count("frame");
  const baseId = c.base_case.split(" ").pop();
  const base = inbound.fencing.frame_cases.find((b) => b.id === baseId);
  if (!base) { fail(`frame.${c.id}`, `no base frame ${baseId} in inbound-protections.json`); continue; }
  if (base.text !== c.text || !same(base.provenance, c.provenance)) fail(`frame.${c.id}`, "text or provenance differs from its base case");
  const lines = base.expected.split("\n");
  const after = lines.findIndex((l) => l.startsWith(c.provenance.trace ? "trace:" : "received:"));
  lines.splice(after + 1, 0, line);
  if (lines.join("\n") !== c.expected) fail(`frame.${c.id}`, "is not its base frame with the audience line after trace: (or received:)");
}

// ── the board ──────────────────────────────────────────────────────────────

const REQUIRED = ["helper", "identities", "envelopes", "tamper", "readings", "receiver", "inbox", "server.task_manager", "server.carriage", "sender.preflight", "frame"];
for (const s of REQUIRED) if (!counts[s]) fail(s, "has no cases; a section nobody checks is decoration");

for (const s of REQUIRED) console.log(`${problems.some((p) => p.startsWith(s)) ? "✗" : "✓"} ${s} (${counts[s] ?? 0})`);
if (problems.length) {
  console.error(`\naudience.json: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`\naudience.json agrees with SPEC.md §5.7 (${Object.values(counts).reduce((a, b) => a + b, 0)} cases)`);
