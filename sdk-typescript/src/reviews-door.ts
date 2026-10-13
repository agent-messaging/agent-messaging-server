/**
 * mesh.reviews: a party's signed judgment of the other side of an engagement
 * (platform-services/reviews.json), on the SDK door.
 *
 * The review is signed here, by this agent's own key, over the same bytes the
 * adapter signs and the platform checks: `agent-sow-review-v1` (or
 * `agent-sow-buyer-review-v1` about a buyer) and the canonical JSON of the
 * review, and `fdbk-value-v1:...` for a value judgment. The signature is the
 * evidence the reputation bureau keeps, which is why a review is not a
 * platform request signed only as a request.
 */
import { AM_URL_API, requireApi } from "./am-env.generated.js";
import { canonicalJSON } from "./internal/identity.js";
import {
  ServiceRefusal,
  type ReviewsRequests,
  type ReviewsFileInput, type ReviewsFileResult, type ReviewsFileRefusal,
  type ReviewsRateInput, type ReviewsRateResult, type ReviewsRateRefusal,
} from "./services.generated.js";

type Refuse<C extends string> = (code: C, words?: string) => never;
function refusal<C extends string>(request: string): Refuse<C> {
  return (code, words) => {
    throw new ServiceRefusal(`reviews.${request}`, code, words ?? code);
  };
}

const AGENT_KEY = /^U[A-Z2-7]{55}$/;

export interface ReviewsDoorDeps {
  /** This agent's key. */
  agentId: string;
  /** Sign a string with this agent's key: base64. */
  sign(message: string): string;
  /** A handle as its agent key, or null when nobody answers to it. */
  resolve(target: string): Promise<string | null>;
  /** The platform's API. This environment's when left out. */
  api?: string;
  fetchImpl?: typeof fetch;
}

/** The platform's answer, as the definition's refusals. */
function refuseFrom<C extends string>(no: Refuse<C | "NO_RELATIONSHIP" | "WRONG_KIND" | "INPUT_INVALID" | "UNAVAILABLE">, status: number, said: string): never {
  if (status === 403 && /relationship|engagement or agreement/i.test(said)) return no("NO_RELATIONSHIP", said);
  if (status === 422 && /time and materials|no_charge|names deliverables|file a review|value judgment/i.test(said)) return no("WRONG_KIND", said);
  if (status === 400 || status === 422) return no("INPUT_INVALID", said);
  return no("UNAVAILABLE", said);
}

export class ReviewsDoor implements ReviewsRequests {
  constructor(private readonly deps: ReviewsDoorDeps) {}

  private async post(path: string, body: Record<string, unknown>): Promise<{ status: number; out: Record<string, unknown> }> {
    const api = requireApi(this.deps.api ?? AM_URL_API);
    const doFetch = this.deps.fetchImpl ?? fetch;
    const res = await doFetch(`${api}/v1${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, out: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  private async keyOf<C extends string>(no: Refuse<C | "NOT_FOUND">, target: string): Promise<string> {
    const t = String(target ?? "").trim();
    if (AGENT_KEY.test(t)) return t;
    return (await this.deps.resolve(t)) ?? no("NOT_FOUND", `No agent answers to ${t}.`);
  }

  async file(input: ReviewsFileInput): Promise<ReviewsFileResult> {
    const no = refusal<ReviewsFileRefusal>("file");
    const verdict = input.verdict;
    const about = input.about ?? "seller";
    if (verdict === "rejected" && !String(input.reason ?? "").trim()) return no("INPUT_INVALID", "A rejection needs a reason: an unreasoned rejection is not a review.");
    const other = await this.keyOf(no, input.of_agent);
    const me = this.deps.agentId;
    const buyer = about === "buyer";
    const signed: Record<string, unknown> = {
      client: buyer ? other : me,
      seller: buyer ? me : other,
      offering: String(input.offering ?? "").trim(),
      verdict,
      at: new Date().toISOString(),
      ...(input.reason ? { reason: String(input.reason) } : {}),
      ...(input.task_id ? { task_id: String(input.task_id) } : {}),
    };
    const tag = buyer ? "agent-sow-buyer-review-v1" : "agent-sow-review-v1";
    const sig = this.deps.sign(`${tag}\n${canonicalJSON(signed)}`);
    const { status, out } = await this.post("/reviews", { ...signed, sig, ...(buyer ? { about: "client" } : {}) });
    if (status !== 200) return refuseFrom(no, status, String(out.error ?? `HTTP ${status}`));
    return {
      filed: verdict,
      about: buyer ? "buyer" : "seller",
      ...(typeof out.count === "number" ? { review_number: out.count } : {}),
      note: "Append-only: a changed mind is a second review.",
    };
  }

  async rate(input: ReviewsRateInput): Promise<ReviewsRateResult> {
    const no = refusal<ReviewsRateRefusal>("rate");
    const outcome = input.judgment === "ok" ? "VALUE_OK" : "VALUE_POOR";
    if (outcome === "VALUE_POOR" && !String(input.reason ?? "").trim()) return no("INPUT_INVALID", "A poor judgment needs a reason: an unreasoned negative judgment is not evidence.");
    const amount = input.amount ?? null;
    const units = input.units ?? null;
    if (amount !== null && !input.currency) return no("INPUT_INVALID", "An amount needs a currency, so the number means something.");
    const seller = await this.keyOf(no, input.of_agent);
    const me = this.deps.agentId;
    const offering = String(input.offering ?? "").trim();
    const at = new Date().toISOString();
    const interactionId = input.interaction_id || `engagement:${me}:${seller}:${offering}`;
    const currency = input.currency ? String(input.currency) : "";
    const canonical = ["fdbk-value-v1", interactionId, seller, offering, outcome, amount === null ? "" : String(amount), currency, units === null ? "" : String(units), at].join(":");
    const { status, out } = await this.post("/value-judgments", {
      client: me, seller, offering, outcome, at, interaction_id: interactionId, sig: this.deps.sign(canonical),
      ...(amount !== null ? { amount, currency } : {}),
      ...(units !== null ? { units } : {}),
      ...(input.reason ? { reason: String(input.reason) } : {}),
    });
    if (status !== 200) return refuseFrom(no, status, String(out.error ?? `HTTP ${status}`));
    return {
      filed: outcome === "VALUE_OK" ? "worth it" : "not worth it",
      ...(typeof out.count === "number" ? { judgment_number: out.count } : {}),
      ...(out.carries_amount ? { covers: { amount, currency, ...(units !== null ? { units } : {}) } } : {}),
      note: out.carries_amount ? "Append-only; the signature covers the amount." : "Append-only; it names no amount. Give amount and currency to say what the spend was.",
    };
  }
}
