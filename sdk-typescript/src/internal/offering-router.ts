import type { Envelope, TraceContext, Budget } from "../types/envelope.js";
import type { AllowanceUsage } from "../allowance.js";
import type { TrialContext } from "../trial.js";

export interface RequestContext {
  /** The full inbound envelope — use `envelope.payload` for offering/config. */
  envelope: Envelope;
  taskId: string;
  traceContext: TraceContext;
  /** The requester's budget for this work (§7.7), validated before the handler
   *  runs. Read it BEFORE doing any work: accepting the request is a statement
   *  that the work fits inside it, and a handler that cannot deliver within it
   *  must refuse at admission (`budgetInsufficient` / `deadlineUnmeetable`)
   *  rather than accept and fail mid-flight. Absent when the request carried
   *  no budget. */
  budget?: Budget;
  /** Report this task's model usage to the EXT-8 allowance meter — `{ tokens }`
   *  (converted through the armed document's cost_model, floor-rounded) or
   *  `{ cost_micro }` (money directly). The SDK cannot see the host's model
   *  bill; this is how the host supplies it. Accounted to this task, its
   *  `context_id`, and the UTC day; the task's total flows into the terminal
   *  respond's `cost` field (§19.3, informative). A no-op when no allowance is
   *  armed at all (`AgentMesh.setAllowance`); a FAIL-CLOSED allowance still
   *  keeps the books — refusal stops new spend, it never erases the record. */
  reportUsage(usage: AllowanceUsage): void;
  /** Report a declared meter quantity for this task's §13.5 usage receipt —
   *  `ctx.reportMeter("tokens_out", 4210)`. Additive within the task; the
   *  accumulated entries ride the terminal respond as `payload.usage`, covered
   *  by the envelope signature. Meter names are the responder's own
   *  (`tokens_in`, `tokens_out`, `model_ms`, `tool_calls`, …) and MUST NOT
   *  collide with the observed set; quantities are non-negative integers.
   *  Throws INPUT_INVALID on a malformed report — at the report site, not
   *  three calls later. Distinct from `reportUsage`, deliberately: that one
   *  is money through the owner's cost model (EXT-8), this one is quantity in
   *  the responder's own units, and only one of them needs a cost model. */
  reportMeter(meter: string, quantity: number): void;
  /** Present when the node admitted this request as trial work (Common Agent
   *  7.7): who asked, the trial's shape, and the caps only the work can
   *  measure (pages, seconds, items). The work keeps inside them; the
   *  requester owes nothing, and the spend is the publisher's. */
  trial?: TrialContext;
}

/**
 * An offering handler. Receives the request's **inner input** (not the wrapping
 * `{ offering, input, config }` payload) — matching the Rust SDK's `on_request`.
 * The full payload is available via `ctx.envelope.payload` when needed.
 */
export type OfferingHandler = (
  input: unknown,
  ctx: RequestContext,
) => Promise<unknown> | unknown;

/** Writer interface passed to streaming offering handlers. */
export interface StreamWriter {
  /** Send an incremental chunk. */
  write(data: unknown, contentType?: string): void;
  /** Send the final chunk and complete the stream. */
  end(data?: unknown, contentType?: string): void;
  /** Whether end() has been called. */
  readonly closed: boolean;
  /** The task ID for this stream. */
  readonly taskId: string;
}

/** Handler for streaming requests. Receives a StreamWriter to push chunks. */
export type StreamOfferingHandler = (
  input: unknown,
  ctx: RequestContext,
  writer: StreamWriter,
) => Promise<void> | void;

/** Per-handler options (§10.8). Registered alongside the handler; the SDK
 *  consults them, not the handler. */
export interface HandlerOptions {
  /** Auto-propagation of cancels (§10.8): when a cancel arrives for a task
   *  whose handler issued sub-requests that have not reached a terminal
   *  state, the SDK forwards a cancel to each still-live delegate as
   *  `upstream_cancelled`. Default: **true** — the omitted option is never
   *  the unguarded one. Set `false` in exactly one case: the handler manages
   *  its own delegates and would double-cancel otherwise. */
  propagateCancel?: boolean;
  /** The §7.0 deferral threshold (ms) for this offering's bare handler.
   *  Unset (the default) keeps today's behaviour: the handler's return is the
   *  one terminal respond, however long it takes — and a caller whose timeout
   *  is shorter never sees it. With a threshold, a LIVE dispatch whose handler
   *  is still running when it elapses goes deferred: the dispatcher answers
   *  the live wait with a non-terminal `{status: "working"}` respond carrying
   *  the dispatch task id, and the handler's eventual result — completed with
   *  the output, sealed as a bare answer would be, or failed — is published as
   *  a signed update on `mesh.task.{id}.update`, recorded durably by the task
   *  manager (§7.4) and recovered by `awaitTask` / the requester's local task
   *  store. Mailbox-drained dispatches never defer. Pick a threshold under the
   *  callers' request timeout — the point is to answer before they stop
   *  listening. */
  deferAfterMs?: number;
  /** The §7.7 admission phase, run AFTER the §22 inbound checks and BEFORE the
   *  §6.4a accept signal is emitted and the handler is invoked. Throw
   *  `budgetInsufficient(...)` / `deadlineUnmeetable(...)` (or any MeshError)
   *  here to refuse admission: the refusal is then the FIRST reply, which is
   *  what §6.4a requires — "refusals of admission happen instead of an accept,
   *  never after one". A handler that instead throws those from its own body
   *  refuses after the accept has already been sent, which the spec forbids;
   *  admission decisions belong here. `ctx.budget` carries the offer. */
  admit?: (ctx: RequestContext) => void | Promise<void>;
}

export class OfferingRouter {
  private handlers = new Map<string, OfferingHandler>();
  private streamHandlers = new Map<string, StreamOfferingHandler>();
  private handlerOptions = new Map<string, HandlerOptions>();
  private defaultHandler: OfferingHandler | null = null;

  register(offeringId: string, handler: OfferingHandler, options?: HandlerOptions): void {
    this.handlers.set(offeringId, handler);
    if (options !== undefined) this.handlerOptions.set(offeringId, options);
  }

  unregister(offeringId: string): void {
    this.handlers.delete(offeringId);
    if (!this.streamHandlers.has(offeringId)) this.handlerOptions.delete(offeringId);
  }

  setDefault(handler: OfferingHandler): void {
    this.defaultHandler = handler;
  }

  resolve(offeringId: string): OfferingHandler | null {
    return this.handlers.get(offeringId) ?? this.defaultHandler;
  }

  /** The options registered for an offering, if any. An offering served by the
   *  default handler has none and gets every default. */
  optionsFor(offeringId: string): HandlerOptions | undefined {
    return this.handlerOptions.get(offeringId);
  }

  registerStream(offeringId: string, handler: StreamOfferingHandler, options?: HandlerOptions): void {
    this.streamHandlers.set(offeringId, handler);
    if (options !== undefined) this.handlerOptions.set(offeringId, options);
  }

  unregisterStream(offeringId: string): void {
    this.streamHandlers.delete(offeringId);
    if (!this.handlers.has(offeringId)) this.handlerOptions.delete(offeringId);
  }

  resolveStream(offeringId: string): StreamOfferingHandler | null {
    return this.streamHandlers.get(offeringId) ?? null;
  }

  get offerings(): string[] {
    return Array.from(this.handlers.keys());
  }
}
