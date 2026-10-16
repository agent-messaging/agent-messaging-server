/**
 * The mesh's own requests on the SDK door (platform-services/*.json with
 * "part": "mesh"; docs/platform-services-plan.md P3): mesh.messages,
 * mesh.contacts, mesh.owner, mesh.identity, mesh.names, mesh.feeds and
 * mesh.registry, with the same names, fields, answers and refusals as the MCP
 * tools (messages_send, feeds_read, ...) and the command line (agentmesh
 * messages send, ...).
 *
 * They are built on the SDK's own primitives, which stay as they were:
 * request(), discover(), declareFeed(), publishFeed(), subscribeFeed(),
 * feedValue(). What a program can only do with those (listen for each
 * message as it arrives, be called on each new feed value) it still does with
 * them; these requests answer the questions every door answers.
 *
 * The generated interfaces (services.generated.ts) hold each class to its
 * definition: a field or a refusal the definition lacks fails to compile.
 */
import type { AgentMesh } from "./mesh.js";
import { Diagnostics } from "./diagnostics.js";
import type { AdmissionGate, InboxMessage, WaitingSender } from "./admission.js";
import { MeshError } from "./types/errors.js";
import {
  ServiceRefusal,
  type MessagesRequests, type MessagesSendInput, type MessagesSendResult, type MessagesSendRefusal,
  type ContactsRequests, type ContactsKnockInput, type ContactsKnockResult, type ContactsKnockRefusal,
  type ContactsPresenceInput, type ContactsPresenceResult, type ContactsPresenceRefusal,
  type OwnerRequests, type OwnerAskInput, type OwnerAskResult, type OwnerAskRefusal,
  type IdentityRequests, type IdentityMeResult, type IdentityMeRefusal,
  type NamesRequests, type NamesResolveInput, type NamesResolveResult, type NamesResolveRefusal,
  type NamesClaimInput, type NamesClaimResult, type NamesClaimRefusal,
  type NamesConfirmInput, type NamesConfirmResult, type NamesConfirmRefusal,
  type FeedsRequests, type FeedsDeclareInput, type FeedsDeclareResult, type FeedsDeclareRefusal,
  type FeedsPublishInput, type FeedsPublishResult, type FeedsPublishRefusal,
  type FeedsFollowInput, type FeedsFollowResult, type FeedsFollowRefusal,
  type FeedsUnfollowInput, type FeedsUnfollowResult, type FeedsUnfollowRefusal,
  type FeedsReadInput, type FeedsReadResult, type FeedsReadRefusal,
  type FeedsListResult, type FeedsRetireInput, type FeedsRetireResult, type FeedsRetireRefusal,
  type RegistryRequests, type RegistryListInput, type RegistryListResult, type RegistryListRefusal,
} from "./services.generated.js";

// ── the agent's own side of admission (admission.ts): the inbox and the door ─
//
// Not in the generated definitions, which record these as adapter-only
// ("An SDK program ... keeps no inbox"); since 0.60.0 an SDK program keeps
// one when it starts admission, and these are its calls, with the same names,
// fields and refusals as the adapter's MCP tools.

export interface MessagesInboxResult { messages: InboxMessage[] }
export interface MessagesReplyInput { inbox_id: string; text: string }
export interface MessagesReplyResult { replied_to: string; delivered: boolean; note?: string }
export type MessagesReplyRefusal = "NOT_FOUND" | "NOT_NAMED" | "TOO_BIG" | "INPUT_INVALID" | "NOT_RUNNING";
export interface MessagesDismissInput { inbox_ids: string[] }
export interface MessagesDismissResult { dismissed: number }
export type MessagesDismissRefusal = "INPUT_INVALID" | "NOT_RUNNING";
/** `mesh.messages`: sending, and the inbox. */
export interface MessagesInboxRequests {
  inbox(): Promise<MessagesInboxResult>;
  reply(input: MessagesReplyInput): Promise<MessagesReplyResult>;
  dismiss(input: MessagesDismissInput): Promise<MessagesDismissResult>;
}

export interface ContactsWaitingResult { senders: WaitingSender[] }
/** `sender`: one agent, by name or id. `source` instead: every agent whose
 *  identity came from one source (EXT-6 0.5.0), `oauth:<issuer>` or
 *  `spiffe://<trust domain>`. */
export interface ContactsAdmitInput { sender?: string; source?: string; note?: string }
export interface ContactsAdmitResult { name: string; released: number }
export type ContactsAdmitRefusal = "NOT_WAITING" | "INPUT_INVALID" | "NOT_RUNNING";
export interface ContactsBlockInput { sender?: string; source?: string; note?: string }
export interface ContactsBlockResult { name: string; dropped: number }
export type ContactsBlockRefusal = "NOT_WAITING" | "INPUT_INVALID" | "NOT_RUNNING";
/** `mesh.contacts`: knocking, presence, and the agent's own door. */
export interface ContactsAdmissionRequests {
  waiting(): Promise<ContactsWaitingResult>;
  admit(input: ContactsAdmitInput): Promise<ContactsAdmitResult>;
  block(input: ContactsBlockInput): Promise<ContactsBlockResult>;
}

const AGENT_ID_RE = /^U[A-Z2-7]{55}$/;
const FEED_TOPIC_RE = /^[A-Za-z0-9_-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The most a message's text may be, in characters: the mesh's own cap on
 *  one inbound message (DEFAULT_MAX_INBOUND_CHARS). Over it, refused; never cut. */
export const MESH_TEXT_MAX = 64 * 1024;
/** What a knock may ask to be allowed to do. */
const KNOCK_GRANTS = ["messages", "scheduling", "share", "errands"];
/** How many values a followed feed keeps in memory, as the adapter's log does. */
const FEED_LOG_MAX = 200;

/** What the doors need from the AgentMesh that holds them. */
export interface MeshDoorContext {
  mesh: AgentMesh;
  /** The platform's API (the platformApi option, or this environment's). */
  api(): string;
  /** The naming service (ConnectOptions.requireNamed says where it comes
   *  from), or undefined on a mesh with none known. */
  registrar(): string | undefined;
  /** This agent's admission (admission.ts), when it was started. */
  admission(): AdmissionGate | null;
  /** Store the signed roster on the mesh, when the server takes it. */
  syncRoster(): Promise<void>;
  /** This agent's declared feeds, by topic, and the way to drop one. */
  declaredFeeds(): Array<{ topic: string; kind: "state" | "stream" }>;
  retireFeed(topic: string): boolean;
}

type Refuse<C extends string> = (code: C, words?: string) => never;
function refusal<C extends string>(request: string, said: Record<string, string> = {}): Refuse<C> {
  return (code, words) => {
    throw new ServiceRefusal(request, code, words?.trim() ? words : said[code] ?? code);
  };
}
const errCode = (e: unknown): string => String((e as { code?: unknown })?.code ?? "");
const errWords = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A handle or agent id, resolved at the naming service and checked. */
async function resolveAgent<C extends string>(ctx: MeshDoorContext, no: Refuse<C>, codes: { notFound: C; renamed?: C }, target: unknown): Promise<{ agent_id: string; handle?: string; notice?: string }> {
  const t = str(target);
  if (!t) return no(codes.notFound, "Say which agent: a handle or an agent id.");
  if (AGENT_ID_RE.test(t)) return { agent_id: t };
  const r = await new Diagnostics(ctx.mesh, { registrar: ctx.registrar() }).resolve(t).catch((e) => ({ resolved: false, error: errWords(e) } as { resolved: false; error: string; movedTo?: string }));
  if (!r.resolved && "movedTo" in r && r.movedTo && codes.renamed) return no(codes.renamed, r.error ?? `${t} was renamed to ${r.movedTo}.`);
  if (!r.resolved || !("agentId" in r) || !r.agentId) return no(codes.notFound, `${t} could not be found, or its card failed its signature check.`);
  return { agent_id: r.agentId, handle: t, ...(r.notice ? { notice: r.notice } : {}) };
}

/** A send's refusal from the SDK, as a request's refusal when one fits. */
function sendRefusal<C extends string>(no: Refuse<C>, e: unknown, codes: { notNamed?: C; refused?: C }): never {
  const code = errCode(e);
  if (code === "NOT_NAMED" && codes.notNamed) return no(codes.notNamed, errWords(e));
  if (codes.refused && e instanceof MeshError) return no(codes.refused, errWords(e));
  throw e;
}

// ── messages ────────────────────────────────────────────────────────────────

export class MessagesDoor implements MessagesRequests, MessagesInboxRequests {
  constructor(private readonly ctx: MeshDoorContext) {}

  async send(input: MessagesSendInput): Promise<MessagesSendResult> {
    const no = refusal<MessagesSendRefusal>("messages.send");
    const text = typeof input?.text === "string" ? input.text : "";
    if (!text.trim()) no("INPUT_INVALID", "Say the message: text is empty.");
    if (text.length > MESH_TEXT_MAX) no("TOO_BIG", `That message is ${text.length} characters; a message takes at most ${MESH_TEXT_MAX}. Send it as a file instead.`);
    const to = await resolveAgent(this.ctx, no, { notFound: "NOT_FOUND", renamed: "RENAMED" }, input?.to);
    const body = { text, ...(input.resources?.length ? { resources: input.resources } : {}) };
    try {
      const r = await this.ctx.mesh.request(to.agent_id, "chat", body, { timeout_ms: 60_000, ...(input.context ? { context_id: input.context } : {}) });
      const p = (r.payload as { output?: unknown })?.output ?? r.payload;
      const reply = typeof p === "string" ? p : (p as { text?: unknown })?.text ?? p;
      return { delivered: true, reply, request_id: r.envelope.in_reply_to ?? undefined, ...(to.notice ? { notice: to.notice } : {}) };
    } catch (e) {
      const details = ((e as { details?: Record<string, unknown> }).details ?? {}) as { queued?: boolean; request_id?: string };
      if (errCode(e) === "REQUEST_QUEUED" || details.queued === true) {
        return {
          delivered: false,
          ...(details.request_id ? { request_id: details.request_id } : {}),
          note: "Sent. The agent's mailbox holds it; any reply arrives later as a message to this agent.",
          ...(to.notice ? { notice: to.notice } : {}),
        };
      }
      if (/timeout|no response/i.test(errWords(e))) {
        return {
          delivered: false,
          ...(details.request_id ? { request_id: details.request_id } : {}),
          note: "Sent. The agent did not answer within a minute; if it is offline the mesh holds the message, and any reply arrives later as a message to this agent.",
          ...(to.notice ? { notice: to.notice } : {}),
        };
      }
      return sendRefusal(no, e, { notNamed: "NOT_NAMED", refused: "REFUSED" });
    }
  }

  /** The admission that keeps the inbox, or the refusal that says to start it. */
  private gate(request: string): AdmissionGate {
    const g = this.ctx.admission();
    if (!g) {
      throw new ServiceRefusal(request, "NOT_RUNNING", "This agent keeps no inbox yet: start admission first (await mesh.admission.start({ inbox: true })).");
    }
    return g;
  }

  /** The messages waiting in this agent's inbox: released held messages, and
   *  with `inbox: true` every message for an offering nothing handles.
   *  Answer with reply(); clear what is done with dismiss(). */
  async inbox(): Promise<MessagesInboxResult> {
    return { messages: this.gate("messages.inbox").harnessListing() };
  }

  /** Answer a message in the inbox, by its id. The answer goes to the sender
   *  as a new message (to its `chat` offering) that names the message it
   *  answers, the way the reference adapter answers. It does not clear the
   *  message; dismiss() does that. */
  async reply(input: MessagesReplyInput): Promise<MessagesReplyResult> {
    const no = refusal<MessagesReplyRefusal>("messages.reply");
    const gate = this.gate("messages.reply");
    const id = str(input?.inbox_id);
    if (!id) no("INPUT_INVALID", "Say which message: its inbox_id, as inbox() lists it.");
    const text = typeof input?.text === "string" ? input.text : "";
    if (!text.trim()) no("INPUT_INVALID", "Say the reply: text is empty.");
    if (text.length > MESH_TEXT_MAX) no("TOO_BIG", `That reply is ${text.length} characters; a message takes at most ${MESH_TEXT_MAX}. Send it as a file instead.`);
    const m = gate.message(id);
    if (!m) return no("NOT_FOUND", `No message ${id} is in the inbox. inbox() lists the ones that are.`);
    let delivered = true;
    let note: string | undefined;
    try {
      await this.ctx.mesh.request(m.from, "chat", { text, in_reply_to: m.id }, { timeout_ms: 30_000, ...(m.context_id ? { context_id: m.context_id } : {}) });
    } catch (e) {
      const details = ((e as { details?: Record<string, unknown> }).details ?? {}) as { queued?: boolean };
      if (errCode(e) === "REQUEST_QUEUED" || details.queued === true) {
        delivered = false;
        note = "Sent. The sender's mailbox holds it until the sender reads it.";
      } else if (/timeout|no response/i.test(errWords(e))) {
        delivered = false;
        note = "Sent. The sender did not answer within 30 seconds; if it is offline the mesh holds the reply for it.";
      } else {
        return sendRefusal(no, e, { notNamed: "NOT_NAMED" });
      }
    }
    gate.markReplied(id);
    return { replied_to: m.from, delivered, ...(note ? { note } : {}) };
  }

  /** Clear messages out of the inbox, by id, without replying. */
  async dismiss(input: MessagesDismissInput): Promise<MessagesDismissResult> {
    const no = refusal<MessagesDismissRefusal>("messages.dismiss");
    const gate = this.gate("messages.dismiss");
    const ids = Array.isArray(input?.inbox_ids) ? input.inbox_ids.map(String).filter(Boolean) : [];
    if (!ids.length) no("INPUT_INVALID", "Say which messages: inbox_ids, as inbox() lists them.");
    return { dismissed: gate.dismiss(ids) };
  }
}

// ── contacts ────────────────────────────────────────────────────────────────

export class ContactsDoor implements ContactsRequests, ContactsAdmissionRequests {
  constructor(private readonly ctx: MeshDoorContext) {}

  async knock(input: ContactsKnockInput): Promise<ContactsKnockResult> {
    const no = refusal<ContactsKnockRefusal>("contacts.knock");
    const grants = input?.grants === undefined ? [] : (Array.isArray(input.grants) ? input.grants : [input.grants]).map(String);
    if (grants.some((g) => !KNOCK_GRANTS.includes(g))) no("INPUT_INVALID", `grants are names from this list only: ${KNOCK_GRANTS.join(", ")}`);
    const via = str(input?.via);
    if (via.length > 80) no("INPUT_INVALID", `via is at most 80 characters; that is ${via.length}.`);
    const to = await resolveAgent(this.ctx, no, { notFound: "NOT_FOUND" }, input?.to);
    let answer: { refused?: boolean; code?: string; error?: string } | null = null;
    try {
      const r = await this.ctx.mesh.request(to.agent_id, "knock", { ...(via ? { via } : {}), ...(grants.length ? { grants } : {}) }, { timeout_ms: 30_000 });
      const p = ((r.payload as { output?: unknown })?.output ?? r.payload) as { refused?: boolean; code?: string; error?: string } | null;
      answer = p && typeof p === "object" ? p : null;
    } catch (e) {
      // A knock that times out still knocked: the other side records it before anything answers.
      if (!/timeout|no response/i.test(errWords(e))) return sendRefusal(no, e, { notNamed: "NOT_NAMED", refused: "REFUSED" });
    }
    if (answer?.refused) no("REFUSED", `${input.to} turned the knock away (${answer.code ?? "REFUSED"}): ${answer.error ?? "no reason given"}`);
    return { to: to.agent_id, note: "Knocked. Its owner decides; once they let you in, your messages go through. Nothing comes back to say no.", ...(to.notice ? { notice: to.notice } : {}) };
  }

  async presence(input: ContactsPresenceInput = {}): Promise<ContactsPresenceResult> {
    const no = refusal<ContactsPresenceRefusal>("contacts.presence");
    const who = (input.who ?? []).map((w) => String(w).trim()).filter(Boolean);
    if (!who.length) return { contacts: [] };
    const named = new Map<string, string>();
    for (const w of who) {
      if (AGENT_ID_RE.test(w)) { named.set(w, w); continue; }
      const r = await new Diagnostics(this.ctx.mesh, { registrar: this.ctx.registrar() }).resolve(w).catch(() => null);
      named.set(r?.resolved && r.agentId ? r.agentId : `?${w}`, w);
    }
    const ids = [...named.keys()].filter((k) => AGENT_ID_RE.test(k));
    let found: Awaited<ReturnType<AgentMesh["discover"]>>;
    try { found = await this.ctx.mesh.discover({ agent_ids: ids }); } catch (e) { return no("UNAVAILABLE", `Presence could not be read: ${errWords(e)}`); }
    const byId = new Map((found.agents ?? []).map((m) => [(m as { id?: string }).id ?? (m as { agent_id?: string }).agent_id ?? "", m as { availability?: string; description?: string }]));
    const rank: Record<string, number> = { online: 0, busy: 1, degraded: 2, quiet: 3 };
    const contacts = [...named.entries()].map(([id, name]) => {
      const m = AGENT_ID_RE.test(id) ? byId.get(id) : undefined;
      const raw = String(m?.availability ?? (m ? "online" : "quiet")).toLowerCase();
      const state = (raw === "live" ? "online" : ["online", "busy", "degraded"].includes(raw) ? raw : "quiet") as "online" | "busy" | "degraded" | "quiet";
      const desc = String(m?.description ?? "");
      const attended = desc.includes("(a live session answers)") ? true : desc.includes("(unattended)") ? false : undefined;
      const line = state === "online"
        ? `online${attended === true ? " · a live session may answer" : attended === false ? " · unattended, answers on its own" : ""}`
        : state === "quiet" ? "quiet · messages wait for it" : state;
      return { name, ...(AGENT_ID_RE.test(id) ? { agent_id: id } : {}), state, ...(attended === undefined ? {} : { attended }), line };
    });
    return { contacts: contacts.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name)) };
  }

  private gate(request: string): AdmissionGate {
    const g = this.ctx.admission();
    if (!g) {
      throw new ServiceRefusal(request, "NOT_RUNNING", "Admission is off for this agent, so nobody waits at its door: start it first (await mesh.admission.start()).");
    }
    return g;
  }

  /** Senders new to this agent who are waiting at its door, longest first:
   *  who knocked, and who sent a message the roster holds. Nothing from them
   *  arrives until they are let in. Tell the owner, and ask about each one. */
  async waiting(): Promise<ContactsWaitingResult> {
    return { senders: this.gate("contacts.waiting").waiting() };
  }

  /** Let a sender in. Only at the owner's word: from now on its messages
   *  reach this agent, and what it already sent moves to the inbox. A sender
   *  not waiting can be let in by agent id before it ever writes. */
  async admit(input: ContactsAdmitInput): Promise<ContactsAdmitResult> {
    const no = refusal<ContactsAdmitRefusal>("contacts.admit");
    const gate = this.gate("contacts.admit");
    const source = str(input?.source);
    if (source) {
      try { gate.setSourceStance(source, "allow", str(input?.note) || undefined); } catch (e) { return no("INPUT_INVALID", (e as Error).message); }
      await this.ctx.syncRoster();
      return { name: source, released: 0 };
    }
    const sender = str(input?.sender);
    if (!sender) no("INPUT_INVALID", "Say who: their name as waiting() gave it, or an agent id.");
    const id = gate.resolve(sender);
    if (!id) return no("NOT_WAITING", `Nobody called ${sender} is waiting. waiting() gives the names that are.`);
    const out = gate.admit(id, str(input?.note) || undefined);
    await this.ctx.syncRoster();
    return out;
  }

  /** Keep a sender out. Only at the owner's word: what it already sent is
   *  dropped, and nothing from it reaches this agent. A guarded inbox drops
   *  its mail on the mesh from now on. */
  async block(input: ContactsBlockInput): Promise<ContactsBlockResult> {
    const no = refusal<ContactsBlockRefusal>("contacts.block");
    const gate = this.gate("contacts.block");
    const source = str(input?.source);
    if (source) {
      try { gate.setSourceStance(source, "block", str(input?.note) || undefined); } catch (e) { return no("INPUT_INVALID", (e as Error).message); }
      await this.ctx.syncRoster();
      return { name: source, dropped: 0 };
    }
    const sender = str(input?.sender);
    if (!sender) no("INPUT_INVALID", "Say who: their name as waiting() gave it, or an agent id.");
    const id = gate.resolve(sender);
    if (!id) return no("NOT_WAITING", `Nobody called ${sender} is waiting. waiting() gives the names that are, or give an agent id.`);
    const out = gate.block(id, str(input?.note) || undefined);
    await this.ctx.syncRoster();
    return out;
  }
}

// ── owner ───────────────────────────────────────────────────────────────────

export class OwnerDoor implements OwnerRequests {
  constructor(private readonly ctx: MeshDoorContext) {}

  async ask(input: OwnerAskInput = {}): Promise<OwnerAskResult> {
    const no = refusal<OwnerAskRefusal>("owner.ask", { NOT_LINKED: "This agent is not linked to its owner's AgentMesh account, so there is nobody to ask." });
    const text = str(input.text);
    if (!input.settles && !text) no("INPUT_INVALID", "Say the question, or give settles.");
    if (text.length > MESH_TEXT_MAX) no("INPUT_INVALID", `That question is ${text.length} characters; a message takes at most ${MESH_TEXT_MAX}.`);
    const mesh = this.ctx.mesh;
    const ts = new Date().toISOString();
    let res: Response;
    try {
      res = await fetch(`${this.ctx.api()}/v1/agent/owner`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: mesh.id, ts, sig: mesh.signDetached(`owner-agent-v1:${mesh.id}:${ts}`) }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      return no("UNAVAILABLE", `AgentMesh could not be reached to find the owner: ${errWords(e)}`);
    }
    if (res.status === 404) no("NOT_LINKED");
    const body = (await res.json().catch(() => ({}))) as { hosted?: { agent_id?: string; handle?: string | null }; error?: string };
    if (!res.ok || !body.hosted?.agent_id) no("UNAVAILABLE", `AgentMesh could not say which agent is the owner's: ${body.error ?? `HTTP ${res.status}`}`);
    const hosted = body.hosted as { agent_id: string; handle?: string | null };
    const who = hosted.handle ?? hosted.agent_id;
    const choices = (input.choices ?? []).map((c) => String(c).trim()).filter(Boolean);
    const payload = input.settles
      ? { text: text || "Settled.", ask: { settles: String(input.settles) } }
      : { text, ask: { kind: "question", ...(choices.length ? { choices } : {}) } };
    try {
      const r = await mesh.request(hosted.agent_id, "chat", payload, { timeout_ms: 10_000 });
      if (input.settles) return { to: who, settled: String(input.settles) };
      return { to: who, held: false, ...(r.envelope.in_reply_to ? { request_id: r.envelope.in_reply_to } : {}) };
    } catch (e) {
      const details = ((e as { details?: Record<string, unknown> }).details ?? {}) as { queued?: boolean; captured?: boolean; request_id?: string };
      if (errCode(e) === "REQUEST_QUEUED" || errCode(e) === "AGENT_UNAVAILABLE" || details.queued || details.captured || /timeout|no response/i.test(errWords(e))) {
        return { to: who, held: true, ...(input.settles ? { settled: String(input.settles) } : details.request_id ? { request_id: details.request_id } : {}) };
      }
      return sendRefusal(no, e, { notNamed: "NOT_NAMED" });
    }
  }
}

// ── identity ────────────────────────────────────────────────────────────────

export class IdentityDoor implements IdentityRequests {
  constructor(private readonly ctx: MeshDoorContext) {}

  async me(): Promise<IdentityMeResult> {
    void refusal<IdentityMeRefusal>; // the definition's refusals are for the other doors
    const mesh = this.ctx.mesh;
    const status = mesh.namingStatus() ?? (await mesh.recheckName().catch(() => null));
    // No naming check on this agent (requireNamed: false): asked here instead.
    let handle = status?.handle ?? null;
    const registrar = this.ctx.registrar();
    if (!status && registrar) {
      const raw = await fetch(`${registrar}/api/resolve?agent_id=${encodeURIComponent(mesh.id)}`, { signal: AbortSignal.timeout(6000) })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null) as { card?: { handle?: string } } | null;
      handle = raw?.card?.handle ?? null;
    }
    // With no naming rule and no naming service known, nothing stands
    // between this agent and sending: the mesh knows it by its key.
    const canSend = status ? status.named || !!status.unchecked : !registrar || !!handle;
    return {
      agent_id: mesh.id,
      ...(handle ? { handle, name: handle.split(".")[0] } : {}),
      can_send: canSend,
      ...(canSend ? {} : {
        why_not: "AgentMesh uses one global standard for agent names: the agent's name, a dot, and its owner's email. This agent does not have one yet, so it cannot send.",
        get_a_name: "Ask the person for their email and the name they want, call names.claim() with both, then names.confirm() with the code they are emailed.",
      }),
    };
  }
}

// ── names ───────────────────────────────────────────────────────────────────

export class NamesDoor implements NamesRequests {
  /** A claim waiting for its code: in this process only. */
  private pending: { email: string; name: string; token?: string } | null = null;
  constructor(private readonly ctx: MeshDoorContext) {}

  async resolve(input: NamesResolveInput): Promise<NamesResolveResult> {
    const no = refusal<NamesResolveRefusal>("names.resolve");
    const t = str(input?.target);
    if (!t) no("INPUT_INVALID", "Say which agent: a handle or an agent id.");
    const r = await new Diagnostics(this.ctx.mesh, { registrar: this.ctx.registrar() }).resolve(t).catch((e) => ({ resolved: false, error: errWords(e) } as { resolved: false; error: string; movedTo?: string }));
    if (!r.resolved && "movedTo" in r && r.movedTo) no("RENAMED", r.error ?? `${t} was renamed to ${r.movedTo}.`);
    if (!r.resolved || !("agentId" in r) || !r.agentId) {
      if (AGENT_ID_RE.test(t)) return { agent_id: t };
      return no("NOT_FOUND", `${t} could not be found, or its card failed its signature check.`);
    }
    // The card itself, as the naming service serves it (Diagnostics checked it above).
    const q = AGENT_ID_RE.test(t) ? `agent_id=${encodeURIComponent(t)}` : `handle=${encodeURIComponent(t)}`;
    const registrar = this.ctx.registrar();
    const raw = !registrar ? null : await fetch(`${registrar}/api/resolve?${q}`, { signal: AbortSignal.timeout(8000) }).then((x) => x.json()).catch(() => null) as { card?: Record<string, unknown> & { handle?: string } } | null;
    const handle = raw?.card?.handle ?? (AGENT_ID_RE.test(t) ? undefined : t);
    return { agent_id: r.agentId, ...(handle ? { handle } : {}), ...(raw?.card ? { card: raw.card } : {}), ...(r.notice ? { notice: r.notice } : {}) };
  }

  async claim(input: NamesClaimInput): Promise<NamesClaimResult> {
    const no = refusal<NamesClaimRefusal>("names.claim");
    const status = this.ctx.mesh.namingStatus();
    if (status?.named) no("ALREADY_NAMED", `This agent already has its name${status.handle ? `, ${status.handle}` : ""}. Renaming happens on its page in the app.`);
    const email = str(input?.email).toLowerCase();
    if (!EMAIL_RE.test(email)) no("INPUT_INVALID", "Give the owner's email: the code goes there. Ask the person for it; never guess.");
    const name = str(input?.name).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
    if (!name) no("INPUT_INVALID", "That name has no letters or numbers to use. Offer a short name, like little-buddy.");
    await this.post(no, "/api/handles/start", { email });
    this.pending = { email, name };
    return { name, handle: `${name}.${email}`, code_sent_to: email };
  }

  async confirm(input: NamesConfirmInput): Promise<NamesConfirmResult> {
    const no = refusal<NamesConfirmRefusal>("names.confirm");
    const code = str(input?.code);
    if (!code) no("INPUT_INVALID", "Give the code from the email.");
    const mesh = this.ctx.mesh;
    const bind = async (pairCode: string): Promise<string | undefined> => {
      const signature = mesh.signDetached(`pan-pair-v1:${pairCode.toUpperCase()}:${mesh.id}`);
      const done = await this.post(no, "/api/pair/complete", { code: pairCode, agent_id: mesh.id, signature }, undefined, "CODE_WRONG");
      await mesh.recheckName().catch(() => null);
      return (done as { handle?: string }).handle;
    };
    const asked = str(input?.name);
    // A name the owner claimed in the app: the full handle and the pairing code shown there.
    if (!this.pending && asked.includes("@")) {
      const handle = (await bind(code)) ?? asked;
      return { handle, agent_id: mesh.id, check_at: `${this.ctx.registrar()}/api/resolve?handle=${encodeURIComponent(handle)}` };
    }
    const pending = this.pending;
    if (!pending) return no("NO_CLAIM");
    if (!pending.token) {
      const v = await this.post(no, "/api/handles/verify", { email: pending.email, code }, undefined, "CODE_WRONG");
      pending.token = (v as { token?: string }).token;
    }
    let operator = str(input?.display_name);
    if (!operator) {
      const o = await fetch(`${this.ctx.registrar()}/api/operator`, { headers: { authorization: `Bearer ${pending.token}` }, signal: AbortSignal.timeout(10_000) }).then((x) => x.json()).catch(() => ({})) as { name?: string };
      operator = o.name ?? "";
      if (!operator) no("NEEDS_DISPLAY_NAME");
    }
    const name = asked ? asked.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") : pending.name;
    const claimed = await this.post(no, "/api/handles/claim", { name, operator_name: operator }, pending.token, "NAME_TAKEN") as { handle: string };
    const pair = await this.post(no, "/api/pair/start", { handle: claimed.handle }, pending.token) as { code: string };
    const handle = (await bind(String(pair.code))) ?? claimed.handle;
    this.pending = null;
    return { handle, agent_id: mesh.id, check_at: `${this.ctx.registrar()}/api/resolve?handle=${encodeURIComponent(handle)}` };
  }

  private async post<C extends string>(no: Refuse<C | "UNAVAILABLE" | "INPUT_INVALID">, path: string, body: unknown, token?: string, codeOnRefusal?: C): Promise<unknown> {
    const registrar = this.ctx.registrar();
    if (!registrar) return no("UNAVAILABLE", "No naming service is known for this mesh, so there is nowhere to claim a name. A mesh that offers none knows its agents by their keys.");
    let res: Response;
    try {
      res = await fetch(`${registrar}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      return no("UNAVAILABLE", `The naming service did not answer: ${errWords(e)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.ok) return data;
    if (res.status >= 500) return no("UNAVAILABLE", data.error ?? `the naming service answered ${res.status}`);
    return no(codeOnRefusal ?? "INPUT_INVALID", data.error ?? `the naming service answered ${res.status}`);
  }
}

// ── feeds ───────────────────────────────────────────────────────────────────

export class FeedsDoor implements FeedsRequests {
  /** The feeds this program follows, with what arrived while it followed. */
  private following = new Map<string, { agent_id: string; handle?: string; topic: string; log: Array<{ at: string; data: unknown }>; stop: () => void }>();
  constructor(private readonly ctx: MeshDoorContext) {}

  async declare(input: FeedsDeclareInput): Promise<FeedsDeclareResult> {
    const no = refusal<FeedsDeclareRefusal>("feeds.declare");
    const kind = input?.kind ?? "state";
    if (!FEED_TOPIC_RE.test(String(input?.topic ?? ""))) no("INPUT_INVALID", `A feed's name is letters, digits, - and _ only, like build-status. ${JSON.stringify(input?.topic ?? "")} is not.`);
    if (kind !== "state" && kind !== "stream") no("INPUT_INVALID", `A feed's kind is state or stream, not ${JSON.stringify(kind)}.`);
    this.ctx.mesh.declareFeed(input.topic, kind);
    return { topic: input.topic, kind, note: this.ctx.mesh.registered ? "Public to the whole mesh. It is published with this agent's next registration." : "Public to the whole mesh. It is published when this agent registers." };
  }

  async publish(input: FeedsPublishInput): Promise<FeedsPublishResult> {
    const no = refusal<FeedsPublishRefusal>("feeds.publish");
    if (!FEED_TOPIC_RE.test(String(input?.topic ?? ""))) no("INPUT_INVALID", `A feed's name is letters, digits, - and _ only. ${JSON.stringify(input?.topic ?? "")} is not.`);
    const declared = this.ctx.declaredFeeds().find((d) => d.topic === input.topic);
    const kind = declared?.kind ?? "state";
    const data = typeof input.data === "string" ? (() => { try { return JSON.parse(input.data as string); } catch { return { text: input.data }; } })() : input.data;
    try {
      this.ctx.mesh.publishFeed(input.topic, data, { kind });
    } catch (e) {
      return sendRefusal(no, e, { notNamed: "NOT_NAMED" });
    }
    return { topic: input.topic, kind, ...(declared ? {} : { note: `${input.topic} is not declared, so readers cannot find it. feeds.declare() fixes that.` }) };
  }

  async follow(input: FeedsFollowInput): Promise<FeedsFollowResult> {
    const no = refusal<FeedsFollowRefusal>("feeds.follow");
    if (!FEED_TOPIC_RE.test(String(input?.topic ?? ""))) no("INPUT_INVALID", `A feed's name is letters, digits, - and _ only. ${JSON.stringify(input?.topic ?? "")} is not.`);
    const owner = await resolveAgent(this.ctx, no, { notFound: "NOT_FOUND" }, input?.target);
    const key = `${owner.agent_id}/${input.topic}`;
    if (!this.following.has(key)) {
      const entry = { agent_id: owner.agent_id, ...(owner.handle ? { handle: owner.handle } : {}), topic: input.topic, log: [] as Array<{ at: string; data: unknown }>, stop: () => {} };
      const watch = await this.ctx.mesh.trackFeed(owner.agent_id, input.topic, (payload) => {
        entry.log.push({ at: new Date().toISOString(), data: payload?.data ?? null });
        if (entry.log.length > FEED_LOG_MAX) entry.log.shift();
      });
      entry.stop = watch.stop;
      this.following.set(key, entry);
    }
    return { agent_id: owner.agent_id, topic: input.topic, note: `Followed while this program runs. The most recent ${FEED_LOG_MAX} values are kept; feeds.read() shows them. Nothing arrives as a message.` };
  }

  async unfollow(input: FeedsUnfollowInput): Promise<FeedsUnfollowResult> {
    const no = refusal<FeedsUnfollowRefusal>("feeds.unfollow");
    const owner = await resolveAgent(this.ctx, no, { notFound: "NOT_FOUND" }, input?.target);
    const key = `${owner.agent_id}/${input.topic}`;
    const entry = this.following.get(key);
    if (!entry) no("NOT_FOLLOWED", `This program does not follow ${input.topic} from ${input.target}.`);
    entry!.stop();
    this.following.delete(key);
    return { agent_id: owner.agent_id, topic: input.topic };
  }

  async read(input: FeedsReadInput): Promise<FeedsReadResult> {
    const no = refusal<FeedsReadRefusal>("feeds.read");
    const topic = String(input?.topic ?? "");
    if (!FEED_TOPIC_RE.test(topic)) no("INPUT_INVALID", `A feed's name is letters, digits, - and _ only. ${JSON.stringify(topic)} is not.`);
    let agentId: string;
    if (str(input?.target).toLowerCase() === "agentmesh") {
      // AgentMesh's own channels have no handle: the platform says which key signs each topic.
      const channels = await fetch(`${this.ctx.api()}/v1/platform-channels`, { signal: AbortSignal.timeout(8000) })
        .then((r) => r.json()).then((b) => ((b as { channels?: Array<{ topic?: string; agent?: string }> }).channels ?? [])).catch(() => []);
      const hit = channels.find((c) => c.topic === topic && c.agent);
      if (!hit) no("NOT_FOUND", `AgentMesh has no channel ${JSON.stringify(topic)}. Its channels: ${channels.filter((c) => c.topic && c.agent).map((c) => c.topic).join(", ") || "none could be read just now"}.`);
      agentId = hit!.agent as string;
    } else {
      agentId = (await resolveAgent(this.ctx, no, { notFound: "NOT_FOUND" }, input?.target)).agent_id;
    }
    let env: Awaited<ReturnType<AgentMesh["feedValue"]>> = null;
    let unavailable = false;
    try { env = await this.ctx.mesh.feedValue(agentId, topic); } catch { unavailable = true; }
    const followed = this.following.get(`${agentId}/${topic}`);
    const n = Math.min(Math.max(Number(input.limit) || 20, 1), FEED_LOG_MAX);
    const log = (followed?.log ?? []).slice(-n); // cut-ok: the definition's limit, asked for by the caller
    const p = (env?.payload ?? {}) as { data?: unknown; kind?: string };
    return {
      agent_id: agentId,
      topic,
      ...(env ? { current: p.data ?? null, as_of: env.ts, ...(p.kind ? { kind: p.kind } : {}) } : {}),
      log,
      ...(unavailable ? { note: "The current value could not be read just now." }
        : !env ? { note: "This feed has never published, or nothing on this mesh keeps its value." }
        : !followed ? { note: "No log: feeds.follow() keeps one while this program runs." } : {}),
    };
  }

  async list(): Promise<FeedsListResult> {
    const mesh = this.ctx.mesh;
    const valueOf = async (agent: string, topic: string): Promise<{ current?: unknown }> => {
      try { const env = await mesh.feedValue(agent, topic); return env ? { current: (env.payload as { data?: unknown })?.data ?? null } : {}; }
      catch { return {}; }
    };
    const declared = [];
    for (const d of this.ctx.declaredFeeds()) declared.push({ ...d, ...(await valueOf(mesh.id, d.topic)) });
    const following = [];
    for (const f of this.following.values()) following.push({ agent_id: f.agent_id, ...(f.handle ? { handle: f.handle } : {}), topic: f.topic, ...(await valueOf(f.agent_id, f.topic)) });
    return { declared, following };
  }

  async retire(input: FeedsRetireInput): Promise<FeedsRetireResult> {
    const no = refusal<FeedsRetireRefusal>("feeds.retire");
    if (!this.ctx.retireFeed(String(input?.topic ?? ""))) no("NOT_DECLARED", `This agent declares no feed called ${JSON.stringify(input?.topic ?? "")}. feeds.declare() declares one.`);
    return { topic: input.topic, note: "It leaves this agent's registration the next time it registers. What was published stays public." };
  }
}

// ── registry ────────────────────────────────────────────────────────────────

export class RegistryDoor implements RegistryRequests {
  constructor(private readonly ctx: MeshDoorContext) {}

  async list(input: RegistryListInput = {}): Promise<RegistryListResult> {
    const no = refusal<RegistryListRefusal>("registry.list");
    let res: Awaited<ReturnType<AgentMesh["discover"]>>;
    try {
      res = await this.ctx.mesh.discover({
        ...(input.capability ? { capabilities: [input.capability] } : {}),
        ...(input.offering ? { offering_id: input.offering } : {}),
        ...(input.tags?.length ? { tags: input.tags } : {}),
      });
    } catch (e) {
      return no("UNAVAILABLE", `The registry did not answer: ${errWords(e)}`);
    }
    const agents = (res.agents ?? []).map((m) => {
      const r = m as unknown as { id?: string; agent_id?: string; name?: string; description?: string; offerings?: Array<{ id?: string; name?: string }>; skills?: Array<{ id?: string; name?: string }> };
      return {
        agent_id: (r.id ?? r.agent_id) as string,
        ...(r.name ? { name: r.name } : {}),
        ...(r.description ? { description: r.description } : {}),
        offerings: (r.offerings ?? r.skills ?? []).map((s) => s.id ?? s.name ?? "").filter(Boolean),
      };
    }).filter((a) => a.agent_id);
    return { total: res.total ?? agents.length, agents };
  }
}
