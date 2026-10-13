/**
 * What a statement rested on (§5.6).
 *
 * A signature answers two questions and not a third. It says who made a
 * statement, and it says the words have not changed. It says nothing about
 * whether the things underneath are still what they were, so a deliverable
 * keeps verifying after its inputs have moved and a receipt keeps verifying
 * after the schedule it was priced against has been rewritten. Both are clean
 * signatures over statements that stopped being true.
 *
 * `rests_on` closes that by declaring the bytes a statement was computed from.
 * There is no second signature and no combined root to compute: the member
 * lives inside the statement, so the envelope signature (§4.5, §5.3) already
 * covers it. The declaration IS the mechanism.
 *
 * THE POINT OF THIS MODULE IS THE FOUR-WAY VERDICT, not the validation. A
 * reader needs to tell apart "I looked and it moved", "I could not look", and
 * "nothing was declared", because collapsing any of them into a boolean ends
 * with somebody either relying on a stale statement or accusing an honest one.
 * `stale` in particular is NOT a signature failure and NOT evidence of bad
 * faith: the statement was true when it was made and its signature is still
 * good. What it means is that it is no longer a safe basis for a decision,
 * which is a matter for whoever is deciding, so nothing here throws on it.
 *
 * AGREEMENTS ARE EXCLUDED, and that is why `countersigned` is a parameter
 * rather than something a caller is trusted to remember. A document two
 * parties signed means what it meant when they signed it; an undertaking that
 * silently voided when one side touched a file would be one neither party
 * could rely on, and either could escape by touching it. Pass
 * `{ countersigned: true }` and the answer is `not_applicable` without a
 * single byte being resolved.
 *
 * Shapes and verdicts are pinned by `conformance/rests-on.json`.
 */

import { MeshError, ErrorCode } from "./types/errors.js";

/** `sha256:<64 lowercase hex>`, the §7.5.1 spelling. Case-sensitive on
 *  purpose: the declared string sits inside the signed bytes, so normalising
 *  before comparing would make two different signed statements equal. */
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** A verifier may have to fetch every entry, so an unbounded list is a way to
 *  spend a stranger's bandwidth. Far above any honest statement. */
export const MAX_RESTS_ON = 64;

/** One thing a statement rested on. */
export interface RestsOnEntry {
  /** REQUIRED. `sha256:<64 lowercase hex>` over the bytes depended on. */
  digest: string;
  /** What makes the entry checkable: a verifier resolves it to get the bytes.
   *  Absent is legal and weaker, the same trade §7.5.1 makes the other way
   *  round for a ref with no digest. */
  ref?: string;
  name?: string;
  /** What this input was to the statement ("input", "rate-schedule"). Open
   *  vocabulary, for the reader. */
  role?: string;
}

/**
 * The verdict.
 *
 * `undeclared` is not a milder `fresh` and `unchecked` is not a milder
 * `stale`. They are different facts and callers are expected to branch on all
 * four.
 */
export type Freshness =
  | "fresh"
  | "stale"
  | "unchecked"
  | "undeclared"
  | "not_applicable";

export interface FreshnessResult {
  state: Freshness;
  /** Entries observed with a different digest, with what was seen. Non-empty
   *  exactly when the state is `stale`. */
  changed: Array<{ entry: RestsOnEntry; observed: string }>;
  /** Entries the verifier could not obtain, or obtained unintelligibly. */
  unreachable: RestsOnEntry[];
}

/** What the verifier can see right now for one entry: the digest of the bytes
 *  as they are today, or `null` when it could not obtain them. Synchronous and
 *  caller-supplied, so this module performs no I/O and imposes no store. */
export type Observe = (entry: RestsOnEntry) => string | null | undefined;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a `rests_on` list. Throws `INPUT_INVALID` naming the single fault.
 *
 * Throwing is right here and wrong for the verdict: a malformed list is the
 * producer's own programming error, caught at the site that builds it, while a
 * stale verdict is a fact about the world that the caller has to weigh.
 */
export function validateRestsOn(value: unknown): asserts value is RestsOnEntry[] {
  if (!Array.isArray(value)) {
    throw new MeshError(ErrorCode.INPUT_INVALID, "rests_on must be an array of entries (§5.6)");
  }
  if (value.length === 0) {
    // Omitting the member already means "declares nothing". Two spellings of
    // one state is how two implementations come to disagree about which is
    // which, so the empty list is refused rather than quietly folded in.
    throw new MeshError(
      ErrorCode.INPUT_INVALID,
      "rests_on must not be empty (§5.6): omit the member instead, which is what declaring nothing means",
    );
  }
  if (value.length > MAX_RESTS_ON) {
    throw new MeshError(
      ErrorCode.INPUT_INVALID,
      `rests_on carries at most ${MAX_RESTS_ON} entries (§5.6), got ${value.length}`,
    );
  }
  const seenRefs = new Set<string>();
  for (const [i, raw] of value.entries()) {
    if (!isRecord(raw)) {
      throw new MeshError(ErrorCode.INPUT_INVALID, `rests_on[${i}] must be an object with a digest (§5.6)`);
    }
    const { digest, ref, name, role } = raw as Partial<RestsOnEntry>;
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
      throw new MeshError(
        ErrorCode.INPUT_INVALID,
        `rests_on[${i}].digest must be sha256:<64 lowercase hex> (§5.6)`,
      );
    }
    if (ref !== undefined) {
      if (typeof ref !== "string" || ref.length === 0) {
        throw new MeshError(
          ErrorCode.INPUT_INVALID,
          `rests_on[${i}].ref must be a non-empty opaque URI when present (§7.5.1)`,
        );
      }
      if (seenRefs.has(ref)) {
        // One reference cannot have rested on two different sets of bytes. The
        // statement contradicts itself and no verdict over it would mean
        // anything, so it is refused at the point of construction.
        throw new MeshError(
          ErrorCode.INPUT_INVALID,
          `rests_on names ${ref} twice with different digests (§5.6)`,
        );
      }
      seenRefs.add(ref);
    }
    if (name !== undefined && typeof name !== "string") {
      throw new MeshError(ErrorCode.INPUT_INVALID, `rests_on[${i}].name must be a string when present`);
    }
    if (role !== undefined && typeof role !== "string") {
      throw new MeshError(ErrorCode.INPUT_INVALID, `rests_on[${i}].role must be a string when present`);
    }
  }
}

/**
 * Is what this statement rested on still what it rested on?
 *
 * `declared` is the statement's own `rests_on`, or undefined when it has none.
 * `observe` answers with the digest of each input as it is today, or null when
 * the verifier cannot obtain it. An entry with no `ref` is never observable
 * and is always counted unreachable: there is nothing to resolve.
 *
 * Never throws on the answer. A verdict is an input to somebody's decision,
 * and a module that threw on `stale` would be making that decision for them.
 */
export function checkFreshness(
  declared: RestsOnEntry[] | undefined | null,
  observe: Observe,
  opts: { countersigned?: boolean } = {},
): FreshnessResult {
  const none = { changed: [], unreachable: [] };
  // Checked FIRST, and before anything is resolved. §5.6 excludes agreements
  // from this rule, so a verifier that fetched the inputs anyway would be
  // spending requests to compute a verdict it must then discard.
  if (opts.countersigned) return { state: "not_applicable", ...none };
  if (!declared || declared.length === 0) return { state: "undeclared", ...none };

  const changed: FreshnessResult["changed"] = [];
  const unreachable: RestsOnEntry[] = [];
  for (const entry of declared) {
    if (!entry.ref) {
      unreachable.push(entry);
      continue;
    }
    const seen = observe(entry);
    if (typeof seen !== "string" || !DIGEST_RE.test(seen)) {
      // Unreachable, never stale. An unparseable observation is this
      // verifier's fault or its store's, and calling the statement stale on
      // the strength of it would accuse the producer of something the evidence
      // does not show.
      unreachable.push(entry);
      continue;
    }
    if (seen !== entry.digest) changed.push({ entry, observed: seen });
  }

  // Stale beats unchecked. One input positively known to have moved is a fact,
  // and it is not weakened by a second input this verifier happened not to
  // reach — an implementation that reported `unchecked` here would let a
  // producer hide a known change behind an unreachable neighbour.
  if (changed.length) return { state: "stale", changed, unreachable };
  if (unreachable.length) return { state: "unchecked", changed, unreachable };
  return { state: "fresh", changed, unreachable };
}

/** One line a person can read, for a log or a panel. Says which input moved,
 *  because "stale" without the name sends somebody looking through all of
 *  them. */
export function describeFreshness(r: FreshnessResult): string {
  switch (r.state) {
    case "fresh":
      return "every input it rested on is unchanged";
    case "stale": {
      const names = r.changed.map((c) => c.entry.name ?? c.entry.ref ?? c.entry.digest.slice(0, 16));
      return `no longer current: ${names.join(", ")} changed since this was signed`;
    }
    case "unchecked":
      return `signature is good; ${r.unreachable.length} of the inputs it rested on could not be read, so freshness is unknown`;
    case "undeclared":
      return "says nothing about what it rested on, so freshness cannot be checked";
    case "not_applicable":
      return "a countersigned agreement, which does not go stale when its inputs change";
  }
}
