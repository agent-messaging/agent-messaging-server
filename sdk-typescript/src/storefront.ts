/**
 * Storefront proposals (§8.7, §8.12): the owner edits the listing in the
 * console, and the agent is the one that adopts it.
 *
 * ## Why a proposal and not a write
 *
 * The manifest is signed by the agent's own key (§8.3), and the console does
 * not hold that key: it holds a session belonging to the person who owns the
 * account. So an owner editing their agent's description in a web page cannot
 * write the manifest, and nothing on the platform can write it for them. What
 * the console can do is leave the edit somewhere the agent will look. That is
 * a PROPOSAL: stored per agent key, fetched by the agent itself, merged into
 * what the agent registers, re-registered under the agent's own signature, and
 * then acknowledged so the pending edit clears.
 *
 * The direction is the point. Nothing reaches into the host; the host comes
 * and asks. That is the same shape the reference adapter already uses for the
 * admission roster and the screening choice, and it is what makes a hosted
 * control panel acceptable for a thing running on somebody's own machine.
 *
 * ## Agreeing with the reference adapter
 *
 * `mesh-adapter` has done this since 0.7x (`storefrontProposalApply`), and two
 * implementations of the same door have to agree about what "adopted" means or
 * the console is telling owners something that is only true for half the
 * fleet. So the wire contract here is the adapter's, copied rather than
 * redesigned:
 *
 *   - `POST {apiBase}/v1/storefront-proposals` with `{agent, ts, sig}` fetches
 *     the pending proposal; the same body plus `ack` clears it.
 *   - `sig` is a detached Ed25519 signature, standard base64, over the
 *     UNTAGGED string `storefront-proposal-v1:<agent>:<ts>:<ack or "fetch">`.
 *     Untagged because that is what the server verifies (`verifyAgentSig`);
 *     this is a control-plane check-in, not a protocol document, so it does
 *     not go through §5.3's tagged signing.
 *   - `ts` is ISO-8601 and must be within five minutes of the server's clock,
 *     so a captured signature is not a permanent capability.
 *   - A proposal carries `public` (the storefront block), `listing` (the §8.12
 *     card-level declarations) or both, plus the `proposed_at` stamp that is
 *     also the ack value.
 *   - Merge rules: a `description` present and non-empty replaces, present and
 *     empty CLEARS; `offerings` is a list of ids that replaces wholesale; a
 *     `listing` member arriving as null means the owner cleared it, so it is
 *     deleted rather than stored empty (an empty `coverage` would publish "I
 *     have said something about my coverage and it is nothing", which is a
 *     different and worse claim than having said nothing).
 *
 * Three places this deliberately differs from the adapter, each for a reason
 * that is about where the two run rather than about what adoption means:
 *
 *   1. **The ack waits for the re-registration.** The adapter writes the merge
 *      to disk first, so it can ack even when the republish fails: the edit is
 *      safe and goes out at the next start. An SDK agent holds the merge in
 *      memory only. Acking a failed re-registration would clear the proposal
 *      server-side and lose the owner's words at the next restart, so here the
 *      ack happens only after the registry has taken the new manifest. A
 *      failure leaves the proposal pending and the next poll retries, which is
 *      the same outcome one tick later.
 *   2. **`example_queries` is adopted.** The console sends it on every save
 *      (`app/src/views/listings.ts`) and the API validates and stores it, and
 *      the adapter's merge drops it on the floor. That is a defect in the
 *      adapter rather than a semantic of the door, and reproducing it here
 *      would break the same promise this client exists to keep. Flagged so
 *      whoever fixes the adapter can delete this note.
 *   3. **A descriptor draft is not adopted, and not acked.** A proposal may
 *      carry an Agent Descriptor draft for the agent to fill in, sign and
 *      submit. This SDK has no descriptor surface at all, so it cannot do any
 *      of that. Acking anyway would tell the owner their document was adopted
 *      by an agent that threw it away; leaving it pending is true, and it is
 *      visible in the console as an edit still waiting. The public and listing
 *      halves of such a proposal ARE adopted: half an adoption beats none, and
 *      re-applying them on a later tick is idempotent.
 */
import { keyPairFromSeed } from "./internal/identity.js";
import { setUnrefInterval, type TimerHandle } from "./internal/timers.js";
import {
  DEFAULT_STOREFRONT_POLL_MS,
  MIN_STOREFRONT_POLL_MS,
  STOREFRONT_REQUEST_TIMEOUT_MS,
} from "./constants.js";
import type { ListingDeclarations, PublicBlock } from "./types/manifest.js";

/** The domain string the signature covers, without the tagged-signing frame
 *  §5.3 uses for protocol documents. The server builds the identical string
 *  and verifies against the agent's public key. */
export const STOREFRONT_PROPOSAL_V1 = "storefront-proposal-v1";

/** The proposal door for a control-plane origin: `{apiBase}/v1/storefront-proposals`. */
export function storefrontProposalEndpoint(apiBase: string): string {
  return `${apiBase.replace(/\/$/, "")}/v1/storefront-proposals`;
}

/** The exact bytes signed for a fetch (`ack` omitted) or an acknowledgement
 *  (`ack` = the proposal's `proposed_at`). The literal "fetch" stands in for
 *  the absent ack so the two acts cannot produce the same signature. */
export function storefrontProposalCanonical(agentKey: string, ts: string, ack?: string): string {
  return `${STOREFRONT_PROPOSAL_V1}:${agentKey}:${ts}:${ack ?? "fetch"}`;
}

/** The signed request body. Exported so a host publishing through its own HTTP
 *  client never has to reconstruct the wire contract from this file. */
export function buildStorefrontProposalRequest(
  agentKey: string,
  seed: string | Uint8Array,
  ack?: string,
  now = new Date(),
): { agent: string; ts: string; sig: string; ack?: string } {
  const ts = now.toISOString();
  const kp = keyPairFromSeed(typeof seed === "string" ? seed : new TextDecoder().decode(seed));
  const sig = kp.sign(new TextEncoder().encode(storefrontProposalCanonical(agentKey, ts, ack)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return { agent: agentKey, ts, sig: btoa(bin), ...(ack === undefined ? {} : { ack }) };
}

/** What the console left for this agent. Everything but `proposed_at` is
 *  optional: a save that touched only the §8.12 declarations carries no
 *  `public` at all, and requiring one would silently discard it. */
export interface StorefrontProposal {
  /** The §8.7 storefront the owner authored. Validated by the API before it
   *  was stored, so `offerings` and `example_queries` are already lists of
   *  clean strings by the time they arrive here. */
  public?: Partial<PublicBlock> | null;
  /** The §8.12 card-level declarations. A member present as null means the
   *  owner cleared it. */
  listing?: (Partial<ListingDeclarations> & Record<string, unknown>) | null;
  /** An Agent Descriptor draft for the agent to sign and submit. This SDK
   *  cannot, so its presence suppresses the ack (see the header). */
  descriptor?: Record<string, unknown> | null;
  /** When the owner saved. Also the ack value: acking any other string clears
   *  nothing. */
  proposed_at: string;
}

/** The blocks an agent currently registers, and the same blocks after a merge. */
export interface StorefrontBlocks {
  public?: PublicBlock;
  listing?: ListingDeclarations;
}

/** The result of merging one proposal into what the agent registers. */
export interface StorefrontAdoption extends StorefrontBlocks {
  /** Field names that actually moved, in the order they were read. Empty means
   *  the proposal asked for nothing this SDK could apply, which is a fact worth
   *  reporting rather than a silent no-op. */
  changed: string[];
  /** Members the proposal carried and this SDK does not adopt: today, only the
   *  descriptor draft. Non-empty means the proposal must NOT be acked. */
  unadopted: string[];
}

/**
 * Merge a proposal into the blocks an agent registers.
 *
 * Pure, and exported for exactly that reason: this is the half that has to
 * match the adapter, and a rule you can only exercise by standing up an HTTP
 * server and a registry is a rule that stops being checked.
 *
 * Never mutates `current`. The returned blocks are fresh objects, so a caller
 * can compare or discard them without having already changed its registration.
 */
export function mergeStorefrontProposal(
  current: StorefrontBlocks,
  proposal: StorefrontProposal,
): StorefrontAdoption {
  const changed: string[] = [];
  const unadopted: string[] = [];
  const pub: Record<string, unknown> = { ...(current.public ?? {}) };
  const listing: Record<string, unknown> = { ...(current.listing ?? {}) };

  const p = proposal.public && typeof proposal.public === "object" ? proposal.public : {};
  // Present-and-empty means CLEAR. The owner emptying the box in the console is
  // an instruction, not a mistake, and treating it as "no change" would make a
  // description impossible to withdraw once written.
  if ("description" in p) {
    const d = String((p as { description?: unknown }).description ?? "").trim();
    if (d) {
      if (pub.description !== d) changed.push("description");
      pub.description = d;
    } else if ("description" in pub) {
      delete pub.description;
      changed.push("description");
    }
  }
  // §8.7: a SELECTION OF IDS, replaced wholesale. Not merged: an owner
  // unticking an offering means it should stop being advertised, and a union
  // would make unticking impossible.
  if (Array.isArray(p.offerings)) {
    if (JSON.stringify(pub.offerings) !== JSON.stringify(p.offerings)) changed.push("offerings");
    pub.offerings = [...p.offerings];
  }
  // The one field the adapter drops and this does not. See the header.
  if (Array.isArray(p.example_queries)) {
    if (JSON.stringify(pub.example_queries) !== JSON.stringify(p.example_queries)) {
      changed.push("example_queries");
    }
    pub.example_queries = [...p.example_queries];
  }

  if (proposal.listing && typeof proposal.listing === "object" && !Array.isArray(proposal.listing)) {
    for (const [k, v] of Object.entries(proposal.listing)) {
      if (v === null || v === undefined) {
        if (k in listing) {
          delete listing[k];
          changed.push(`listing.${k}`);
        }
        continue;
      }
      if (JSON.stringify(listing[k]) !== JSON.stringify(v)) changed.push(`listing.${k}`);
      listing[k] = v;
    }
  }

  if (proposal.descriptor && typeof proposal.descriptor === "object") unadopted.push("descriptor");

  return {
    public: Object.keys(pub).length ? (pub as PublicBlock) : undefined,
    listing: Object.keys(listing).length ? (listing as ListingDeclarations) : undefined,
    changed,
    unadopted,
  };
}

/** One HTTP call to the proposal door, with the deadline stated rather than
 *  inherited: `fetch` on Node has no overall timeout, and a stalled socket
 *  would hold the adopter's in-flight guard and stop the loop retrying. Same
 *  reasoning, and the same absence of an inner retry, as credential renewal. */
async function postProposal(
  apiBase: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetchImpl(storefrontProposalEndpoint(apiBase), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(STOREFRONT_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout surfaces as a bare "The operation was aborted", which reads as
    // a bug in the SDK rather than a control plane that did not answer.
    const name = (err as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(
        `the storefront proposal door did not answer within ${STOREFRONT_REQUEST_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `storefront proposal door answered HTTP ${res.status}`);
  }
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** Ask for this agent's pending proposal. `null` means there is none, which is
 *  the normal answer almost every time. Throws on a transport or server
 *  failure, so a caller can tell "nothing to adopt" from "could not ask". */
export async function fetchStorefrontProposal(opts: {
  apiBase: string;
  agentKey: string;
  seed: string | Uint8Array;
  fetchImpl?: typeof fetch;
}): Promise<StorefrontProposal | null> {
  const body = buildStorefrontProposalRequest(opts.agentKey, opts.seed);
  const data = await postProposal(opts.apiBase, body, opts.fetchImpl ?? fetch);
  const proposal = data?.proposal as StorefrontProposal | null | undefined;
  if (!proposal || typeof proposal !== "object") return null;
  // The adapter's gate, kept: a proposal carrying neither half is nothing to
  // adopt. `proposed_at` is what the ack names, so a proposal without one
  // could never be cleared and is treated as absent rather than adopted.
  if (typeof proposal.proposed_at !== "string" || !proposal.proposed_at) return null;
  const carries =
    (proposal.public !== null && typeof proposal.public === "object") ||
    (proposal.listing !== null && typeof proposal.listing === "object") ||
    (proposal.descriptor !== null && typeof proposal.descriptor === "object");
  return carries ? proposal : null;
}

/** Clear a proposal the agent has adopted. `cleared` is the server's word for
 *  whether the pending entry named by `proposed_at` was the one removed. */
export async function ackStorefrontProposal(opts: {
  apiBase: string;
  agentKey: string;
  seed: string | Uint8Array;
  proposedAt: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const body = buildStorefrontProposalRequest(opts.agentKey, opts.seed, opts.proposedAt);
  const data = await postProposal(opts.apiBase, body, opts.fetchImpl ?? fetch);
  return data?.cleared !== false;
}

/** What an adoption pass did, for a host that drives its own clock. */
export interface StorefrontPassResult {
  /** The proposal found, or null when there was nothing pending. */
  proposal: StorefrontProposal | null;
  /** The merge, when one happened. */
  adoption: StorefrontAdoption | null;
  /** Whether the agent re-registered under the merged blocks. */
  registered: boolean;
  /** Whether the pending proposal was cleared server-side. */
  acked: boolean;
}

export interface StorefrontAdopterOptions {
  /** Control-plane origin, e.g. `https://api.agentmesh.ai`. */
  apiBase: string;
  /** The agent whose storefront this is. */
  agentKey: string;
  /** That agent's own seed. The signature IS the authorization here: there is
   *  no session and no token, and a proposal can only be fetched or cleared by
   *  whoever holds the key the listing belongs to. */
  seed: string | Uint8Array;
  /** The blocks as currently registered, read fresh at each pass rather than
   *  captured once, so an agent that re-registered for its own reasons in the
   *  meantime is merged into what it actually published. */
  current: () => StorefrontBlocks;
  /** Adopt the merged blocks: carry them into what this agent registers and
   *  re-register. Throwing means NOT adopted, and nothing is acked. */
  apply: (adoption: StorefrontAdoption) => void | Promise<void>;
  /** How often to look, in ms. Default `DEFAULT_STOREFRONT_POLL_MS` (60s, the
   *  adapter's cadence); anything below `MIN_STOREFRONT_POLL_MS` is clamped up. */
  pollIntervalMs?: number;
  /** Called after a pass that changed something. */
  onAdopted?: (adoption: StorefrontAdoption) => void;
  /** Called when a pass fails, and when a proposal carries something this SDK
   *  cannot adopt. Once per condition, not once per tick. */
  onWarning?: (w: { code: string; message: string; subject?: string }) => void;
  fetchImpl?: typeof fetch;
}

/**
 * The polling half: ask for a proposal, adopt it, acknowledge it.
 *
 * Kept as its own object rather than folded into the client for the same
 * reason `CredentialRenewer` is: a host may want to run one pass at a moment
 * of its own choosing (a webhook, a SIGHUP, a test) without a timer, and a
 * loop that can only be started is a loop that cannot be driven.
 *
 * Nothing here polls unless a host asked for it. An agent that never sets
 * `storefrontProposals` makes no HTTP calls, which matters because the address
 * being polled is a control plane the agent may not even belong to.
 */
export class StorefrontAdopter {
  private timer: TimerHandle | null = null;
  /** The pass currently running, if one is. A second caller JOINS it rather
   *  than being handed an empty result: the loop takes a pass the moment it
   *  starts, so a host calling `adoptStorefront()` right after `register()`
   *  would otherwise be told "nothing pending" by a guard while the real answer
   *  was a few milliseconds away. */
  private pass: Promise<StorefrontPassResult> | null = null;
  /** The proposal we last applied, so a repeat of the same one retries only
   *  the ack. A repeat means our previous ack did not land: the server clears
   *  a proposal on ack and would otherwise not be handing it back. */
  private appliedAt: string | null = null;
  /** Whether the proposal named by `appliedAt` carried something this SDK
   *  cannot adopt, and so must never be acknowledged however many times it
   *  comes back. */
  private appliedUnadopted = false;
  /** Conditions already reported, so a warning sink gets one line per problem
   *  rather than one per minute for as long as the problem lasts. */
  private reported = new Set<string>();
  private lastErrorMessage: string | null = null;

  constructor(private readonly opts: StorefrontAdopterOptions) {}

  /** Why the last pass failed, or null. For a health surface. */
  get lastError(): string | null {
    return this.lastErrorMessage;
  }

  /**
   * One pass. Never throws: this runs on a timer with no caller to catch it,
   * and a listing edit failing to arrive must not take an agent down. A
   * failure is reported through `onWarning` and left for the next pass, which
   * is the whole retry strategy: the proposal is still pending server-side, so
   * nothing has been lost.
   */
  async adoptOnce(): Promise<StorefrontPassResult> {
    if (this.pass) return this.pass;
    this.pass = this.runPass();
    try {
      return await this.pass;
    } finally {
      this.pass = null;
    }
  }

  private async runPass(): Promise<StorefrontPassResult> {
    const empty: StorefrontPassResult = { proposal: null, adoption: null, registered: false, acked: false };
    try {
      const proposal = await fetchStorefrontProposal(this.opts);
      this.clearReport("storefront_poll_failed");
      this.lastErrorMessage = null;
      if (!proposal) return empty;

      // Same proposal we already applied. Two ways that happens, and they get
      // opposite answers:
      //
      //   - we adopted all of it and the ACK did not land, in which case the
      //     merge is done and the ack is the only thing outstanding.
      //     Re-registering would be a registry round trip for a manifest that
      //     is already correct.
      //   - it carries something this SDK cannot adopt, and is deliberately
      //     left pending. Acking it on the next tick would undo that decision
      //     one minute after making it, which is the bug this branch exists to
      //     not have.
      if (proposal.proposed_at === this.appliedAt) {
        if (this.appliedUnadopted) return { proposal, adoption: null, registered: false, acked: false };
        const acked = await this.tryAck(proposal);
        return { proposal, adoption: null, registered: false, acked };
      }

      const adoption = mergeStorefrontProposal(this.opts.current(), proposal);
      await this.opts.apply(adoption);
      this.appliedAt = proposal.proposed_at;
      this.appliedUnadopted = adoption.unadopted.length > 0;
      if (adoption.changed.length) this.opts.onAdopted?.(adoption);
      if (adoption.unadopted.length) {
        this.report(`unadopted:${proposal.proposed_at}`, {
          code: "storefront_partly_unadopted",
          message:
            `the owner's listing edit for ${this.opts.agentKey.slice(0, 12)} carries ` +
            `${adoption.unadopted.join(", ")}, which this SDK cannot adopt, so the edit is left ` +
            `pending rather than acknowledged. The storefront and §8.12 halves were adopted. ` +
            `A descriptor needs an agent that can sign and submit one, which the reference ` +
            `adapter can and this SDK cannot.`,
          subject: this.opts.agentKey,
        });
        return { proposal, adoption, registered: adoption.changed.length > 0, acked: false };
      }
      const acked = await this.tryAck(proposal);
      // `registered` says what happened, not what was attempted. A proposal
      // that asks for what the manifest already says is acknowledged and
      // costs no registry round trip, and reporting otherwise would make a
      // host's "the owner changed something" log lie once per empty save.
      return { proposal, adoption, registered: adoption.changed.length > 0, acked };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.lastErrorMessage = reason;
      this.report("storefront_poll_failed", {
        code: "storefront_poll_failed",
        message:
          `could not adopt the owner's listing edit for ${this.opts.agentKey.slice(0, 12)}: ` +
          `${reason}. The edit stays pending at the control plane and this will keep trying, ` +
          `so nothing is lost. What is lost until it succeeds is the owner seeing their words ` +
          `on this agent's storefront.`,
        subject: this.opts.agentKey,
      });
      return empty;
    }
  }

  /** Acknowledge, and treat a failure the way a failed pass is treated: the
   *  proposal stays pending and comes back next tick, where `appliedAt` sends
   *  it straight here again. */
  private async tryAck(proposal: StorefrontProposal): Promise<boolean> {
    try {
      const acked = await ackStorefrontProposal({
        apiBase: this.opts.apiBase,
        agentKey: this.opts.agentKey,
        seed: this.opts.seed,
        proposedAt: proposal.proposed_at,
        fetchImpl: this.opts.fetchImpl,
      });
      this.clearReport("storefront_ack_failed");
      return acked;
    } catch (err) {
      this.report("storefront_ack_failed", {
        code: "storefront_ack_failed",
        message:
          `adopted the owner's listing edit for ${this.opts.agentKey.slice(0, 12)} but could not ` +
          `tell the control plane: ${err instanceof Error ? err.message : String(err)}. The edit ` +
          `is live on this agent's manifest; the console will keep showing it as pending until ` +
          `an acknowledgement lands.`,
        subject: this.opts.agentKey,
      });
      return false;
    }
  }

  private report(key: string, w: { code: string; message: string; subject?: string }): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.opts.onWarning?.(w);
  }

  private clearReport(key: string): void {
    this.reported.delete(key);
  }

  /** Start the loop, and take one pass immediately: an agent restarting into a
   *  proposal saved while it was down should adopt it now, not in a minute.
   *  Idempotent. */
  start(): void {
    this.stop();
    const every = Math.max(MIN_STOREFRONT_POLL_MS, this.opts.pollIntervalMs ?? DEFAULT_STOREFRONT_POLL_MS);
    this.timer = setUnrefInterval(() => void this.adoptOnce(), every);
    void this.adoptOnce();
  }

  /** Stop the loop. Safe to call when not started. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
