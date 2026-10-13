/**
 * Input problem reports (§6.5, Agent SoW §14): the machine-readable half of
 * an `input_required` pause.
 *
 * When an agent cannot proceed for want of a usable input — it never arrived,
 * it will not open, it is the wrong shape, a permission was revoked, or
 * something no closed set anticipated — it raises a problem report. The code
 * routes; the description is what the counterparty's agent actually reasons
 * from, which is why it is required on every code including the specific
 * ones. `other` is a first-class member: both ends of an engagement are
 * capable of judgment, and a well-described unknown problem is recoverable in
 * a way a bare code never is.
 *
 * The SDK's job here is deliberately small: let a responder raise a report
 * (`InputProblemsError` from a handler), and let a requester read one
 * (`inputProblemsOf`) exactly as sent. What the receiving agent DOES about a
 * report is its own judgment — the SDK informs, it does not prescribe.
 */

import type { Envelope } from "./types/envelope.js";

export const INPUT_PROBLEM_CODES = [
  "missing",
  "unreadable",
  "wrong_format",
  "no_permission",
  "other",
] as const;

export type InputProblemCode = (typeof INPUT_PROBLEM_CODES)[number];

export interface InputProblem {
  /** The name from the engagement's inputs clause when the problem concerns
   *  a named input; otherwise the name the parties will recognize. */
  input: string;
  problem: InputProblemCode;
  /** REQUIRED on every code. Written to be acted on by the counterparty's
   *  agent — this is the field the other side reasons from. */
  description: string;
  /** What would satisfy the report, stated concretely ("text/csv"). */
  expected?: string;
}

/**
 * Validate one report. Returns the list of complaints, empty when the report
 * is well-formed — the same do-not-throw shape the other validators here use.
 */
export function checkInputProblem(raw: unknown): string[] {
  const bad: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["a problem report must be an object"];
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.input !== "string" || !p.input.trim()) {
    bad.push("`input` must name the input the problem concerns");
  }
  if (!INPUT_PROBLEM_CODES.includes(p.problem as InputProblemCode)) {
    bad.push(`\`problem\` must be one of ${INPUT_PROBLEM_CODES.join(", ")}`);
  }
  if (typeof p.description !== "string" || !p.description.trim()) {
    bad.push("`description` is required on every code — it is what the other side acts on");
  }
  if (p.expected !== undefined && typeof p.expected !== "string") {
    bad.push("`expected`, when present, is a string");
  }
  return bad;
}

/**
 * Thrown by a request handler to pause the work on described problems rather
 * than fail it. The dispatch turns this into a non-terminal `input_required`
 * respond carrying `payload.problems`, with a Task so the conversation has
 * somewhere to continue — the same promotion a budget pause gets.
 */
export class InputProblemsError extends Error {
  readonly problems: InputProblem[];

  constructor(problems: InputProblem | InputProblem[], message?: string) {
    const list = Array.isArray(problems) ? problems : [problems];
    const complaints = list.flatMap((p, i) =>
      checkInputProblem(p).map((c) => `problems[${i}]: ${c}`),
    );
    if (!list.length) complaints.push("at least one problem report is required");
    if (complaints.length) {
      // A malformed report thrown at the counterparty is worse than a loud
      // local error: the whole point of the shape is that the other side can
      // act on it.
      throw new Error(`invalid input problem report — ${complaints.join("; ")}`);
    }
    super(message ?? list.map((p) => `${p.input}: ${p.description}`).join("; "));
    this.name = "InputProblemsError";
    this.problems = list;
  }
}

/**
 * The reports on a received envelope, exactly as sent, or an empty array for
 * an envelope that carries none. Malformed entries are dropped rather than
 * repaired: a reader must not act on words this module made up.
 */
export function inputProblemsOf(env: Envelope): InputProblem[] {
  const payload = env.payload as { problems?: unknown } | undefined;
  if (!Array.isArray(payload?.problems)) return [];
  return payload.problems.filter((p): p is InputProblem => checkInputProblem(p).length === 0);
}
