/**
 * The five questions (§3.3.1), as a library.
 *
 * Every agent answers five questions about itself — who are you, what do you
 * do, how are you used, on what terms, what do you refuse — and every answer
 * already lives in operator-declared, signed bytes: the describe document
 * (§10.14), built on the public block (§8.7). This module is the projection
 * from that document to the five answers, and the diff that §3.3.1's
 * consistency rule makes possible: an agent's statements about itself,
 * wherever spoken, are subordinate to its signed declarations, so a stale or
 * inflated self-description stops being an operational nuisance and becomes a
 * checkable defect. Ask, then diff.
 *
 * A LIBRARY, deliberately: describe is served by the platform from declared
 * bytes (§10.14 — a document, not a conversation), so nothing here serves
 * anything. These are pure functions any party uses to project and to
 * compare — a conformance harness, an adapter, a buyer's surface, an
 * interviewer. Nothing here invokes a model, and nothing here invents a fact:
 * every value in a projection is copied or derived from the input bytes, an
 * absent input projects to an absent answer member (absence states nothing),
 * and a question none of whose inputs were declared projects to an EMPTY
 * answer object — explicitly present, stating nothing.
 *
 * The one synthesized sentence is the refusals statement, and it is
 * synthesized precisely because §3.3.1 says refusal is answered mechanically,
 * not by the model: the closure of the declared offerings IS the refusal
 * answer, whoever computes it.
 *
 * Projection and diff shapes are pinned by `conformance/five-questions.json`;
 * the Rust SDK produces byte-identical results over the same fixture.
 */

import { canonicalJSON } from "./internal/identity.js";
import { MeshError, ErrorCode } from "./types/errors.js";
import type { Manifest } from "./types/manifest.js";

/** The set, in the order §3.3.1 names it — also the order the diff reports
 *  mismatches in. */
export const FIVE_QUESTIONS = [
  "identity",
  "capabilities",
  "usage",
  "terms",
  "refusals",
] as const;

export type Question = (typeof FIVE_QUESTIONS)[number];

/** The mechanical refusal sentence (§3.3.1, question 5). Pinned by the
 *  fixture: both SDKs emit these exact bytes. */
export const REFUSAL_STATEMENT = "Requests outside the declared offerings are refused.";

/**
 * The five answers. Each member is an object whose members were copied or
 * derived from the describe document — see `projectFiveQuestions` for which
 * input answers which question. An empty object is an answer too: the agent
 * declared nothing on that question, stated explicitly rather than filled in.
 */
export interface FiveAnswers {
  /** Who are you? `agent_id`, `name`, `owner`, and the registrar-signed
   *  `card` verbatim (SPEC-NAMING §5.3) when the document carried one. */
  identity: Record<string, unknown>;
  /** What do you do? The storefront `description`, the advertised offering
   *  ids (`offerings`), and the registry-materialized `offering_details`
   *  verbatim (§8.7). */
  capabilities: Record<string, unknown>;
  /** How are you used? Schemas, modes, needs/delivers and reporting per
   *  advertised offering, the card-level default modes, and the interaction
   *  style (§8.5.1, §8.5.2, §8.3a). */
  usage: Record<string, unknown>;
  /** On what terms? `skus` (§19.1), `data_use` (§8.10), `compliance`
   *  (§8.11), `sealing` (§8.9), and the `admission` text (§8.7). */
  terms: Record<string, unknown>;
  /** What do you refuse? The closure, computed mechanically: the advertised
   *  offering ids as `boundary`, the `admission` stance when present, and
   *  the standard `statement`. */
  refusals: Record<string, unknown>;
}

/**
 * One conflict between what an agent declared and what it said elsewhere.
 * `declared` is `null` when the declaration has no such member — claiming
 * what was never declared is a mismatch, because the signed bytes do not
 * back it.
 */
export interface AnswerMismatch {
  question: Question;
  /** `<question>.<member>`, or the bare question when the claim was not even
   *  an answer object. */
  path: string;
  declared: unknown;
  claimed: unknown;
}

/** The members of an advertised offering that answer "how are you used" —
 *  the interface slice of a §8.7 `offering_details` entry. */
const USAGE_MEMBERS = [
  "input_modes",
  "output_modes",
  "input_schema",
  "output_schema",
  "streaming",
  "estimated_duration_ms",
  "needs",
  "delivers",
  "reporting",
] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Project a describe document (§10.14: `agent_id`, the signed `card`, the
 * `public` block verbatim, plus the fields that travel with the storefront —
 * `name`, `sealing`, `data_use`, `compliance`, and `interaction` where the
 * source carried it) to the five answers.
 *
 * Copies and derivations only. Unknown members inside verbatim-copied
 * subtrees (the card, a SKU entry, an offering descriptor) ride through
 * untouched; unknown top-level members answer no question and are ignored.
 * Pinned by `conformance/five-questions.json`.
 */
export function projectFiveQuestions(doc: unknown): FiveAnswers {
  if (!isObject(doc)) {
    throw new MeshError(
      ErrorCode.INPUT_INVALID,
      "a describe document is a JSON object (§10.14)",
    );
  }
  const pub = isObject(doc.public) ? doc.public : undefined;

  // 1. Who are you? (§3.3.1 row 1: the agent ID, the registrar-signed card,
  // the owner.)
  const identity: Record<string, unknown> = {};
  if (typeof doc.agent_id === "string") identity.agent_id = doc.agent_id;
  if (typeof doc.name === "string") identity.name = doc.name;
  if (typeof doc.owner === "string") identity.owner = doc.owner;
  if (doc.card !== undefined) identity.card = doc.card;

  // 2. What do you do? (Row 2: the advertised offerings and their
  // registry-materialized details.)
  const capabilities: Record<string, unknown> = {};
  if (typeof pub?.description === "string") capabilities.description = pub.description;
  if (Array.isArray(pub?.offerings)) capabilities.offerings = pub.offerings;
  if (Array.isArray(pub?.offering_details)) capabilities.offering_details = pub.offering_details;

  // 3. How are you used? (Row 3: schemas and modes, needs and delivers,
  // interaction style.) The interface slice of each advertised offering; an
  // entry with nothing but its id still names itself, stating nothing more.
  const usage: Record<string, unknown> = {};
  if (Array.isArray(pub?.offering_details)) {
    const entries: Array<Record<string, unknown>> = [];
    for (const detail of pub.offering_details) {
      if (!isObject(detail) || typeof detail.id !== "string") continue;
      const entry: Record<string, unknown> = { id: detail.id };
      for (const member of USAGE_MEMBERS) {
        if (detail[member] !== undefined) entry[member] = detail[member];
      }
      entries.push(entry);
    }
    if (entries.length > 0) usage.offerings = entries;
  }
  if (Array.isArray(pub?.default_input_modes)) usage.default_input_modes = pub.default_input_modes;
  if (Array.isArray(pub?.default_output_modes)) {
    usage.default_output_modes = pub.default_output_modes;
  }
  if (typeof doc.interaction === "string") usage.interaction = doc.interaction;

  // 4. On what terms? (Row 4: skus, data_use, compliance, sealing, the
  // admission text, the access block.)
  const terms: Record<string, unknown> = {};
  if (Array.isArray(pub?.skus)) terms.skus = pub.skus;
  if (isObject(doc.data_use)) terms.data_use = doc.data_use;
  if (Array.isArray(doc.compliance)) terms.compliance = doc.compliance;
  if (typeof doc.sealing === "string") terms.sealing = doc.sealing;
  if (typeof pub?.admission === "string") terms.admission = pub.admission;
  if (isObject(pub?.access)) terms.access = pub.access;

  // 5. What do you refuse? (Row 5: the closure of the above, answered
  // mechanically.) The advertised ids are the declared boundary; everything
  // outside it is refused, and the admission stance travels with that.
  const boundary: string[] = [];
  const advertised: unknown[] = Array.isArray(pub?.offerings)
    ? pub.offerings
    : Array.isArray(pub?.offering_details)
      ? pub.offering_details.map((d: unknown) => (isObject(d) ? d.id : undefined))
      : [];
  for (const id of advertised) {
    if (typeof id === "string" && id.length > 0 && !boundary.includes(id)) boundary.push(id);
  }
  const refusals: Record<string, unknown> = { boundary };
  if (typeof pub?.admission === "string") refusals.admission = pub.admission;
  if (isObject(pub?.access)) refusals.access = pub.access;
  refusals.statement = REFUSAL_STATEMENT;

  return { identity, capabilities, usage, terms, refusals };
}

/**
 * Diff a claimed set of answers — what an agent said about itself elsewhere,
 * in the same five-question shape — against its declared projection, per
 * §3.3.1's consistency rule: the signed bytes govern.
 *
 * Only claimed members are compared: silence claims nothing, and a declared
 * member nobody repeated is no conflict. Comparison is byte-exact after
 * RFC 8785 canonicalization. Mismatches come back in a fixed order —
 * questions as §3.3.1 names them, members lexicographic within a question —
 * so two implementations report the same conflicts in the same sequence.
 * Pinned by `conformance/five-questions.json`.
 */
export function diffAnswers(declared: FiveAnswers, claimed: unknown): AnswerMismatch[] {
  if (!isObject(claimed)) {
    throw new MeshError(
      ErrorCode.INPUT_INVALID,
      "a claimed answer set is a JSON object keyed by question (§3.3.1)",
    );
  }
  const mismatches: AnswerMismatch[] = [];
  for (const question of FIVE_QUESTIONS) {
    const claimedAnswer = claimed[question];
    if (claimedAnswer === undefined) continue;
    const declaredAnswer: Record<string, unknown> = isObject(declared[question])
      ? declared[question]
      : {};
    if (!isObject(claimedAnswer)) {
      // Not even the right shape: the mismatch is the question itself, with
      // the whole declared answer beside the prose that replaced it.
      mismatches.push({
        question,
        path: question,
        declared: declaredAnswer,
        claimed: claimedAnswer,
      });
      continue;
    }
    for (const member of Object.keys(claimedAnswer).sort()) {
      const claimedValue = claimedAnswer[member];
      if (claimedValue === undefined) continue;
      const declaredValue = declaredAnswer[member];
      if (
        declaredValue === undefined ||
        canonicalJSON(declaredValue) !== canonicalJSON(claimedValue)
      ) {
        mismatches.push({
          question,
          path: `${question}.${member}`,
          declared: declaredValue === undefined ? null : declaredValue,
          claimed: claimedValue,
        });
      }
    }
  }
  return mismatches;
}

/**
 * The describe-shaped document derivable from a registry manifest: what the
 * platform's `describe` answer carries, built from the same declared bytes.
 * The registrar-signed card is deliberately absent — the registry get (§9.2)
 * does not carry it, and inventing one would be synthesis. A caller holding
 * the real §10.14 response projects that instead.
 */
export function describeDocumentOf(manifest: Manifest): Record<string, unknown> {
  const m = manifest as unknown as Record<string, unknown>;
  const doc: Record<string, unknown> = {};
  if (typeof m.id === "string") doc.agent_id = m.id;
  for (const member of [
    "name",
    "owner",
    "interaction",
    "sealing",
    "data_use",
    "compliance",
    "public",
  ]) {
    if (m[member] !== undefined) doc[member] = m[member];
  }
  return doc;
}

/** What `interview` needs from a connected client: the §9.2 registry get —
 *  the SDK's pre-admission read path (`AgentMesh.getManifest`). */
export interface DescribeSource {
  getManifest(agentId: string): Promise<Manifest>;
}

/**
 * The interviewer convenience (§3.3.1, "the interview"): fetch the agent's
 * declared bytes over the connected client, project the five answers, hand
 * them back. Testable by code that holds no model — pair with `diffAnswers`
 * to check a spoken self-description against these.
 */
export async function interview(client: DescribeSource, agentId: string): Promise<FiveAnswers> {
  const manifest = await client.getManifest(agentId);
  return projectFiveQuestions(describeDocumentOf(manifest));
}
