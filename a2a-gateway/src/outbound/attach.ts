/**
 * Outbound direction (BRIDGE-A2A.md §10): attach an external A2A server so it
 * appears on the mesh as a discoverable hosted agent. Mesh requests addressed
 * to it are forwarded as A2A JSON-RPC SendMessage calls; results map back.
 */
import type { Bridge } from "../bridge.js";
import type { AgentMesh } from "../../../sdk-typescript/src/mesh.js";
import { MeshError, ErrorCode } from "../../../sdk-typescript/src/types/errors.js";
import { toTraceparent } from "../../../sdk-typescript/src/internal/trace.js";
import { currentTrace } from "../../../sdk-typescript/src/internal/trace-ambient.js";
import {
  cardToManifestFields,
  jsonRpcInterfaceUrl,
  type AgentCard,
} from "../core/card.js";
import { linkFiles, meshLinker, partsToInput, outputToParts, type FileLinker, type FileSink, type MeshFile } from "../core/parts.js";
import { a2aStateToMesh } from "../core/states.js";
import { partsToA2A10 } from "../core/a2a10.js";
import { rpcErrorToMesh } from "../core/errors.js";
import { BucketPool, TokenBucket } from "../core/ratelimit.js";
import type {
  A2AMessage,
  A2ATask,
  JsonRpcResponse,
  SendMessageParams,
} from "../core/jsonrpc.js";

/** Files a remote A2A agent returns land in the mesh artifact store under the
 *  BRIDGE's owner: the remote has no mesh identity and no quota, so the party
 *  accountable is the one that chose to attach it. */
function fileSink(agent: { putArtifact: (b: Uint8Array, o?: { media_type?: string; name?: string }) => Promise<{ ref: string; size: number; name?: string; media_type: string }> }): FileSink {
  return {
    async store({ name, mediaType, bytes }): Promise<MeshFile> {
      const stored = await agent.putArtifact(bytes, { media_type: mediaType, name });
      return {
        ...(stored.name ? { name: stored.name } : {}),
        ...(stored.media_type ? { media_type: stored.media_type } : {}),
        ref: stored.ref,
        size: stored.size,
      };
    },
  };
}

export interface AttachConfig {
  /** The agent card URL, or a base URL to probe for /.well-known/agent-card.json. */
  url: string;
  /** Static headers for the remote endpoint (e.g. Authorization). */
  headers?: Record<string, string>;
  /**
   * Discovery visibility for the hosted mesh identity. Default (undefined) is
   * the SDK default, `public` — which is the point of the outbound direction
   * (BRIDGE-A2A.md §1: an A2A server "can appear on a mesh as a discoverable,
   * addressable agent"). Set `unlisted` for a remote that should be reachable
   * by id but absent from open discovery — an eval or staging agent — and
   * `private` to withhold it from `get` for non-owners too.
   */
  visibility?: "public" | "unlisted" | "private";
  /**
   * Ceiling on forwarded calls to this remote, across all mesh callers, per
   * minute. The bridge spends someone else's endpoint here; without a ceiling
   * the mesh can be used to hammer a third party. Default 120.
   */
  ratePerMinute?: number;
  /**
   * Per-mesh-caller share of that ceiling, per minute. Default 30 — the same
   * number the inbound guest tier uses, and for the same reason: one caller
   * must not be able to consume the whole budget.
   */
  ratePerCallerPerMinute?: number;
  /**
   * Per-mesh-caller calls per HOUR — a signed standing proposal's volume
   * clause, enforced at this gateway. Null/undefined = no signed clause;
   * only the burst caps above apply.
   */
  ratePerCallerPerHour?: number | null;
  /**
   * Agent NKey seed for the hosted identity. When set, the attachment keeps the
   * SAME mesh id across re-attaches and bridge restarts — an attached agent's
   * id is a fact other agents store. Omitted (the env-var path), a fresh
   * keypair is minted per attach, as before.
   */
  nkeySeed?: string;
  /** Skill ids to expose on the mesh; undefined = every skill the card
   *  declares. An account attaching an endpoint chooses what it stands behind. */
  exposedSkills?: string[];
  /**
   * Called once per forwarded request with the observable facts of the call.
   * Fire-and-forget from the forwarding path's point of view: a usage tap that
   * could fail a brokered request would be worse than none.
   */
  usage?: (sample: UsageSample) => void;
  /**
   * Called when the health probe changes its mind about the remote — false on
   * unreachable (the hosted agent is deregistered), true on recovery (it is
   * re-registered). Survives the internal re-attach, because the re-attach
   * reuses this same config. Lets whoever holds the durable record keep its
   * state field honest instead of frozen at attach time.
   */
  onHealthChange?: (healthy: boolean) => void;
  /**
   * The §7.7 admission decision for a PRICED attachment. When set, every
   * skill registers an admission hook that calls this with the caller's agent
   * id and any offered budget, BEFORE the accept signal; throwing (typically
   * `budgetInsufficient` with the price as the counter-offer) refuses the
   * work. The manager owns the logic — cleared gateway callers pass, mesh
   * callers resolve to an account and are balance-checked (mesh-native
   * clearing), the unresolvable are refused with the price quoted in CREDITS.
   */
  admitPriced?: (callerId: string, budget: unknown) => Promise<void>;
}

/** §7.7 currency for platform credits: integer credits, six decimal places of
 *  micro like every other currency in a cost ceiling.
 *
 *  "XCR", not "CREDITS": every currency field in the protocol is pinned to
 *  the three-letter ISO 4217 shape (budget.ts refuses anything else in a
 *  cost ceiling, and the EXT-8 spend fold fails CLOSED on it — a 7-letter
 *  code meant callers could never offer a credits ceiling and folds silently
 *  accounted nothing). ISO 4217 reserves the X prefix for non-national
 *  units, which is exactly what a platform credit is.
 *  server/src/api/credit-ledger.ts carries the same constant; they must
 *  agree. */
export const CREDITS_CURRENCY = "XCR";
export const MICRO_PER_CREDIT = 1_000_000;

/** One brokered request, as the gateway saw it. The EXT-2 ingest consumes
 *  these; billing later reads the same stream. */
export interface UsageSample {
  skill: string;
  caller: string;
  /** The task id the forward ran under — the settlement's idempotency key. */
  taskId?: string;
  outcome: "ok" | "error";
  latencyMs: number;
  at: string;
}

export interface Attachment {
  config: AttachConfig;
  agent: AgentMesh;
  card: AgentCard;
  rpcUrl: string;
  healthy: boolean;
  detach(): Promise<void>;
}

const HEALTH_INTERVAL_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_FIRST_MS = 250;
const POLL_BUDGET_MS = 55_000;
const DEFAULT_OUTBOUND_PER_MINUTE = 120;
const DEFAULT_OUTBOUND_PER_CALLER_PER_MINUTE = 30;
const CALLER_BUCKETS_MAX = 1000;

export async function attach(bridge: Bridge, config: AttachConfig): Promise<Attachment> {
  const { card, cardUrl } = await fetchCard(config);
  const rpcUrl = jsonRpcInterfaceUrl(card);
  if (!rpcUrl) throw new Error(`No JSONRPC interface in agent card at ${cardUrl}`);

  // JWS card signature verification is deferred; record the fact honestly
  // (BRIDGE-A2A.md §2.1 rule 5 requires recording the verification outcome).
  const fields = cardToManifestFields(card, rpcUrl, false);

  // A persisted seed keeps the identity; no seed keeps the old mint-per-attach.
  const agent = bridge.meshNode.addAgent(config.nkeySeed ? { nkeySeed: config.nkeySeed } : undefined);

  // Outbound rate limiting. The inbound path has had a token bucket since day
  // one; this side had none, so any mesh agent could drive unbounded HTTP at
  // someone else's endpoint through the bridge's vouch. Two buckets, because
  // they answer different questions: the ceiling protects the remote, the
  // per-caller share keeps one mesh agent from eating the whole ceiling.
  const ceiling = new TokenBucket(config.ratePerMinute ?? DEFAULT_OUTBOUND_PER_MINUTE);
  const perCaller = new BucketPool(
    config.ratePerCallerPerMinute ?? DEFAULT_OUTBOUND_PER_CALLER_PER_MINUTE,
    CALLER_BUCKETS_MAX,
  );
  // The signed volume clause, when the owner has standing terms: an hourly
  // per-caller window on top of the per-minute burst caps.
  const perCallerHour = config.ratePerCallerPerHour
    ? new BucketPool(config.ratePerCallerPerHour, CALLER_BUCKETS_MAX, 3_600_000)
    : undefined;
  const limiter: OutboundLimiter = { ceiling, perCaller, perCallerHour, name: card.name };

  // Each declared skill forwards with its skill ID carried in message
  // metadata (BRIDGE-A2A.md §4.5, §10.2), so multi-skill remotes can route.
  // An explicit exposedSkills list narrows the card: the mesh only ever sees
  // (and can only ever call) what the attacher chose to stand behind.
  const offerings = config.exposedSkills
    ? fields.offerings.filter((s) => config.exposedSkills!.includes(s.id))
    : fields.offerings;
  // The §7.7 admission hook for priced attachments (see AttachConfig): the
  // manager's clearing decision, run BEFORE the accept signal, exactly the
  // shape spending-controls documents for any priced mesh agent.
  const admitOptions = config.admitPriced
    ? {
        admit: (ctx: { envelope: { from?: string }; budget?: unknown }) =>
          config.admitPriced!(ctx.envelope?.from ?? "", ctx.budget),
      }
    : undefined;
  for (const offering of offerings) {
    agent.onRequest(offering.id, makeForwardHandler(config, rpcUrl, offering.id, limiter, fileSink(agent), typeof (agent as { artifactLink?: unknown }).artifactLink === "function" ? meshLinker(agent) : null), admitOptions);
  }

  // The §8.7 storefront, from the card. Without this, every attached agent's
  // /a/ page carried an EMPTY public block — no description, no offerings —
  // which is why none of them presented well anywhere the public graph is
  // read (the catalog, the People page, invitations). Only the parts a
  // registrant may write: the registry materializes offering_details and the
  // mode defaults itself from the ids named here. The card's prose skill
  // examples become example_queries — a person wrote them, which is exactly
  // the bar the catalog holds for displayed queries.
  const exposedIds = new Set(offerings.map((o) => o.id));
  const exampleQueries = card.skills
    .filter((s) => exposedIds.has(s.id))
    .flatMap((s) => s.examples ?? [])
    .filter((q) => typeof q === "string" && q.trim().length >= 3 && q.length <= 120)
    .slice(0, 5);
  const publicBlock = {
    ...(fields.description ? { description: fields.description } : {}),
    offerings: offerings.map((o) => o.id),
    ...(exampleQueries.length ? { example_queries: exampleQueries } : {}),
  };

  await agent.register({
    name: fields.name,
    description: fields.description,
    version: fields.version,
    provider: fields.provider,
    capabilities: fields.capabilities,
    offerings,
    // What the remote said it takes and returns, carried through so the mesh
    // manifest is as informative as the card it was built from (§8.5).
    default_input_modes: fields.default_input_modes,
    default_output_modes: fields.default_output_modes,
    extensions: fields.extensions,
    meta: fields.meta,
    public: publicBlock,
    // Passed through explicitly. Left unset it defaults to `public`, which made
    // an unlisted bridged agent impossible without a second, passthrough bridge.
    visibility: config.visibility,
  });
  console.log(`[bridge:outbound] attached "${card.name}" (${rpcUrl}) as ${agent.id.slice(0, 12)}...`);

  const attachment: Attachment = {
    config,
    agent,
    card,
    rpcUrl,
    healthy: true,
    detach: async () => {
      clearInterval(healthTimer);
      await agent.deregister().catch(() => undefined);
      await bridge.meshNode.removeAgent(agent.id);
      console.log(`[bridge:outbound] detached "${card.name}"`);
    },
  };

  // Health-check drives registration (§10.3): unreachable → deregistered
  // (offline to the mesh); healthy again → re-registered.
  const healthTimer = setInterval(async () => {
    const ok = await probe(cardUrl, config.headers);
    if (!ok && attachment.healthy) {
      attachment.healthy = false;
      console.warn(`[bridge:outbound] "${card.name}" unreachable; deregistering`);
      await agent.deregister().catch(() => undefined);
      await bridge.meshNode.removeAgent(agent.id).catch(() => undefined);
      try {
        config.onHealthChange?.(false);
      } catch {
        // The record keeper's problem must not become the health loop's crash.
      }
    } else if (ok && !attachment.healthy) {
      attachment.healthy = true;
      console.log(`[bridge:outbound] "${card.name}" reachable again; re-attaching`);
      // Re-attach with the same config: with an nkeySeed the identity (and so
      // the mesh id) is preserved; without one it is minted fresh, as before.
      const fresh = await attach(bridge, config);
      attachment.agent = fresh.agent;
      // The card the fresh registration was built from, so anything that
      // describes this attachment afterwards (its descriptor) describes the
      // registration that is actually up.
      attachment.card = fresh.card;
      attachment.rpcUrl = fresh.rpcUrl;
      attachment.detach = fresh.detach;
      clearInterval(healthTimer);
      try {
        config.onHealthChange?.(true);
      } catch {
        /* as above */
      }
    }
  }, HEALTH_INTERVAL_MS);

  return attachment;
}

interface OutboundLimiter {
  ceiling: TokenBucket;
  perCaller: BucketPool;
  /** The signed volume clause's hourly window, when standing terms exist. */
  perCallerHour?: BucketPool;
  name: string;
}

/** Charge a forwarded call to every bucket. Throws RATE_LIMITED, which the SDK
 *  returns to the mesh caller as a proper mesh error rather than a timeout. */
function chargeOutbound(limiter: OutboundLimiter, caller: string): void {
  if (limiter.perCallerHour && !limiter.perCallerHour.take(caller)) {
    throw new MeshError(
      ErrorCode.RATE_LIMITED,
      `"${limiter.name}"'s standing terms cap your calls per hour; the window refills continuously.`,
    );
  }
  if (!limiter.perCaller.take(caller)) {
    throw new MeshError(
      ErrorCode.RATE_LIMITED,
      `Too many calls to bridged agent "${limiter.name}" from ${caller.slice(0, 12)}...; slow down.`,
    );
  }
  if (!limiter.ceiling.take()) {
    throw new MeshError(
      ErrorCode.RATE_LIMITED,
      `Bridged agent "${limiter.name}" is at its forwarding ceiling; try again shortly.`,
    );
  }
}

function makeForwardHandler(
  config: AttachConfig,
  rpcUrl: string,
  skillId: string,
  limiter: OutboundLimiter,
  sink?: FileSink,
  linker?: FileLinker | null,
) {
  return async (
    input: unknown,
    ctx: { taskId: string; envelope?: { from?: string } },
  ): Promise<unknown> => {
    const caller = ctx.envelope?.from ?? "unknown";
    // Rate refusals are charged to nobody's meter: the remote was never
    // touched, so there is nothing to bill. The clock starts after admission.
    chargeOutbound(limiter, caller);
    const started = Date.now();
    const tap = (outcome: "ok" | "error") => {
      try {
        config.usage?.({ skill: skillId, caller, taskId: ctx.taskId, outcome, latencyMs: Date.now() - started, at: new Date().toISOString() });
      } catch {
        // A usage tap must never fail a brokered request.
      }
    };

    const params: SendMessageParams = {
      message: {
        role: "ROLE_USER",
        // A mesh file goes to the remote by a signed link this agent asks
        // for: the run-file door needs its owner's session, and the remote
        // has none (AgentMesh technical debt 447). In 1.0's part shape, a
        // `url` part: a stock 1.0 server refuses the 0.3 `file` wrapper.
        parts: partsToA2A10(outputToParts(await linkFiles(input, linker))),
        messageId: ctx.taskId,
        // Both spellings during the §8.5 deprecation window: the far side may
        // be a bridge that has not renamed yet. Metadata is advisory, so the
        // duplicate costs nothing and strands nobody.
        metadata: { "agentmesh.offering": skillId, "agentmesh.skill": skillId },
      },
      // No `configuration`. A2A 1.0 waits for a terminal or interrupted
      // state by default (`returnImmediately` false), which is what this
      // call wants, and the 1.0 release candidate's `blocking` is not a 1.0
      // field: a stock 1.0 server (a2a-sdk 1.1.0) refuses the whole request
      // over it with -32602. A server that answers early with a working task
      // anyway, as the candidate's default did, is polled to the end below.
    };

    try {
      const first = await rpcCall(rpcUrl, config.headers, "SendMessage", params);

      if (first.error) {
        const mesh = rpcErrorToMesh(first.error);
        throw new MeshError(mesh.code, `Remote A2A server: ${mesh.message}`);
      }

      const result = first.result as { task?: A2ATask; message?: A2AMessage };
      let out: unknown;
      if (result?.message) {
        out = await partsToInput(result.message.parts ?? [], sink);
      } else if (result?.task) {
        out = await awaitTask(rpcUrl, config.headers, result.task, sink);
      } else {
        throw new MeshError(ErrorCode.DEPENDENCY_FAILED, "Remote A2A server returned neither task nor message");
      }
      tap("ok");
      return out;
    } catch (err) {
      tap("error");
      throw err;
    }
  };
}

/** Drive a returned A2A task to a terminal state by polling GetTask (§10.2). */
async function awaitTask(
  rpcUrl: string,
  headers: Record<string, string> | undefined,
  task: A2ATask,
  sink?: FileSink,
): Promise<unknown> {
  const deadline = Date.now() + POLL_BUDGET_MS;
  let current = task;
  let polls = 0;
  while (true) {
    const state = a2aStateToMesh(current.status?.state ?? "");
    if (state === "completed") {
      const parts = current.artifacts?.flatMap((a) => a.parts) ?? [];
      return parts.length ? await partsToInput(parts, sink) : {};
    }
    if (state === "failed" || state === "canceled" || state === "rejected") {
      throw new MeshError(ErrorCode.DEPENDENCY_FAILED, `Remote A2A task ${state}`);
    }
    if (state === "input_required" || state === "auth_required") {
      // Multi-turn continuation is out of scope for this version (BRIDGE-A2A.md §11).
      throw new MeshError(ErrorCode.DEPENDENCY_FAILED, `Remote A2A task needs ${state.replace("_", " ")}; multi-turn is not bridged in this version`);
    }
    if (Date.now() > deadline) {
      throw new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "Remote A2A task did not reach a terminal state in time");
    }
    // Soon at first, then every POLL_INTERVAL_MS: a server that answered
    // early (the 1.0 release candidate's default) is often done in moments.
    await sleep(Math.min(POLL_INTERVAL_MS, POLL_FIRST_MS * 2 ** polls++));
    const resp = await rpcCall(rpcUrl, headers, "GetTask", { id: task.id });
    if (resp.error) {
      const mesh = rpcErrorToMesh(resp.error);
      throw new MeshError(mesh.code, `Remote A2A server: ${mesh.message}`);
    }
    current = ((resp.result as { task?: A2ATask })?.task ?? resp.result) as A2ATask;
  }
}

// ─── HTTP plumbing ───────────────────────────────────────────────────

export async function fetchCard(
  config: Pick<AttachConfig, "url" | "headers"> & { sizeLimit?: number; signal?: AbortSignal },
): Promise<{ card: AgentCard; cardUrl: string }> {
  const base = config.url.replace(/\/+$/, "");
  const candidates = base.endsWith("agent-card.json")
    ? [base]
    : [`${base}/.well-known/agent-card.json`, base];
  let lastErr: unknown;
  for (const cardUrl of candidates) {
    try {
      const resp = await fetch(cardUrl, { headers: config.headers, signal: config.signal });
      if (!resp.ok) {
        lastErr = new Error(`${cardUrl}: HTTP ${resp.status}`);
        continue;
      }
      const text = await resp.text();
      if (config.sizeLimit && text.length > config.sizeLimit) {
        lastErr = new Error(`${cardUrl}: card exceeds ${config.sizeLimit} bytes`);
        continue;
      }
      const card = JSON.parse(text) as AgentCard;
      if (!card?.name || !Array.isArray(card.skills)) {
        lastErr = new Error(`${cardUrl}: not an agent card`);
        continue;
      }
      return { card, cardUrl };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Could not fetch agent card for ${config.url}: ${lastErr}`);
}

/** The ambient mesh trace as W3C headers, or nothing when none is running. */
function traceHeaders(): Record<string, string> {
  const t = currentTrace();
  if (!t) return {};
  return {
    traceparent: toTraceparent(t),
    ...(t.tracestate ? { tracestate: t.tracestate } : {}),
  };
}

async function rpcCall(
  rpcUrl: string,
  headers: Record<string, string> | undefined,
  method: string,
  params: unknown,
): Promise<JsonRpcResponse> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "A2A-Version": "1.0",
      // The other direction of SPEC.md §13.1: a mesh trace continues onto the
      // remote endpoint as an ordinary `traceparent`, so the far side's own
      // instrumentation files its work under the trace that caused it.
      // Operator-supplied headers win, in case one of them is pinned.
      ...traceHeaders(),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  if (!resp.ok && resp.headers.get("content-type")?.includes("json") !== true) {
    throw new MeshError(ErrorCode.DEPENDENCY_FAILED, `Remote A2A server: HTTP ${resp.status}`);
  }
  return (await resp.json()) as JsonRpcResponse;
}

async function probe(cardUrl: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const resp = await fetch(cardUrl, { headers, method: "GET" });
    return resp.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
