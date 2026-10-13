/**
 * The bridge door's verbs (SPEC §4.15, step 13 of the bring-your-own-identity
 * plan): the core of Agent Messaging for a caller that holds no mesh key,
 * offered on two fronts beside A2A.
 *
 *   MCP, over streamable HTTP     POST /mcp
 *   HTTPS JSON                    GET /v1/bridge/tools, POST /v1/bridge/tools/:name
 *
 * The sixteen tools, by the three ways agents talk and rooms:
 *
 *   who I am          whoami
 *   finding agents    find_agents, describe_agent, is_online
 *   getting in        knock, review_knocks
 *   inbox messaging   send, check_inbox, reply, task_status
 *   publish/subscribe publish, follow
 *   rooms             open_room, invite_to_room, post_to_room, read_room
 *
 * Every call runs as the caller's lasting hosted identity, so the mesh sees
 * one agent per caller, signed by the bridge under its own vouch, with the
 * identity-bridge marker on every envelope. The credential arrives in the
 * HTTP request (Authorization, and DPoP when the token is bound); no tool
 * takes a credential as an argument, so none reaches the model driving it.
 */
import type { AgentMesh } from "../../../sdk-typescript/src/mesh.js";
import type { Bridge } from "../bridge.js";
import type { BridgeFront } from "../core/card.js";

const AGENT_ID = /^U[A-Z2-7]{55}$/;
const MAX_TEXT = 64 * 1024;
const MAX_FILE = 1024 * 1024;
const SEND_WAIT_S = 20;

export interface ToolContext {
  bridge: Bridge;
  agent: AgentMesh;
  /** The caller key in the bridge's identity pool. */
  key: string;
  front: BridgeFront;
}

/** A refusal a caller can act on: a code and a sentence. */
export class ToolRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const need = (args: Record<string, unknown>, name: string, what: string): string => {
  const v = str(args[name]);
  if (!v) throw new ToolRefusal("INPUT_INVALID", `Say ${what} (${name}).`);
  return v;
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const agentArg = { type: "string", description: "The agent: its id (U followed by 55 characters) or its name." };

/** Read the code and words of an SDK refusal. */
function refusalOf(e: unknown): ToolRefusal {
  if (e instanceof ToolRefusal) return e;
  const err = e as { code?: unknown; refusal?: unknown; message?: unknown };
  const code = typeof err.refusal === "string" ? err.refusal : typeof err.code === "string" ? err.code : "FAILED";
  return new ToolRefusal(code, typeof err.message === "string" ? err.message : String(e));
}

/** What a caller sent, kept for task_status: the request ids this bridge saw. */
const sent = new Map<string, Map<string, { to: string; at: string; status: string; reply?: unknown; note?: string }>>();
/** Which feeds each caller follows, for check_inbox. */
const followed = new Map<string, Array<{ target: string; topic: string }>>();

function remember(key: string, id: string, rec: { to: string; status: string; reply?: unknown; note?: string }): void {
  let m = sent.get(key);
  if (!m) { m = new Map(); sent.set(key, m); }
  if (m.size >= 200) m.delete(m.keys().next().value!);
  m.set(id, { ...rec, at: new Date().toISOString() });
}

/** Drop what the SDK hands back that is not data (a live Room object). */
function plain(v: Record<string, unknown>): Record<string, unknown> {
  const { room: _room, ...rest } = v as Record<string, unknown> & { room?: unknown };
  return rest;
}

export const BRIDGE_TOOLS: ToolDef[] = [
  {
    name: "whoami",
    description: "Who you are on this mesh: your agent id, how the bridge knows you, the tenant you belong to, and where your identity came from. Messages you send are signed by the bridge for you, and receivers can see that.",
    inputSchema: obj({}),
    async run(ctx) {
      const info = ctx.bridge.callerInfo(ctx.key);
      const b = info?.bridged;
      return {
        agent_id: ctx.agent.id,
        caller_kind: info?.kind ?? null,
        caller_ref: info?.ref ?? null,
        bridge: ctx.bridge.nodeId,
        ...(b ? { tenant: b.tenant, workload_id: b.workload_id, credential_expires_at: b.expires_at, identity_source: b.identity_source ?? null, bound_to_key: !!b.jkt } : {}),
        note: "You hold no mesh key: the bridge signs for you, and every message you send is marked as bridged.",
      };
    },
  },
  {
    name: "find_agents",
    description: "Find agents on this mesh: by words in their name or description, by what they offer, or only those online now.",
    inputSchema: obj({
      text: { type: "string", description: "Words to look for in an agent's name or description." },
      offering: { type: "string", description: "Only agents that offer this (an offering id, such as chat)." },
      online_only: { type: "boolean", description: "Only agents that are online now." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "At most this many. Default 20." },
    }),
    async run(ctx, args) {
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20) || 20));
      const text = str(args.text).toLowerCase();
      const r = await ctx.agent.discover({
        ...(str(args.offering) ? { offering_id: str(args.offering) } : {}),
        ...(args.online_only === true ? { availability: "online" as const } : {}),
        limit: text ? 200 : limit,
      });
      const agents = r.agents
        .filter((m) => !text || `${m.name ?? ""} ${m.description ?? ""}`.toLowerCase().includes(text))
        .slice(0, limit)
        .map((m) => {
          const x = m as typeof m & { availability?: string; identity_source?: { kind?: string } };
          return {
            agent_id: m.id, name: m.name, description: m.description,
            offerings: (m.offerings ?? []).map((o) => o.id),
            ...(x.availability ? { availability: x.availability } : {}),
            ...(x.identity_source?.kind ? { identity_source: x.identity_source.kind } : {}),
          };
        });
      return { agents, total: r.total };
    },
  },
  {
    name: "describe_agent",
    description: "Read an agent's public card without bothering it: what it is, what it offers, and where its identity came from. Allowed before you are let in.",
    inputSchema: obj({ agent: agentArg }, ["agent"]),
    async run(ctx, args) {
      try { return { ...(await ctx.agent.describe(need(args, "agent", "which agent"))) }; } catch (e) { throw refusalOf(e); }
    },
  },
  {
    name: "is_online",
    description: "Whether an agent is there right now.",
    inputSchema: obj({ agent: agentArg }, ["agent"]),
    async run(ctx, args) {
      try { return { ...(await ctx.agent.contacts.presence({ who: [need(args, "agent", "which agent")] })) }; } catch (e) { throw refusalOf(e); }
    },
  },
  {
    name: "knock",
    description: "Ask to be let into an agent's inbox. Its owner decides; once they let you in, your messages go through.",
    inputSchema: obj({ agent: agentArg, via: { type: "string", description: "One short line on how you found it (at most 80 characters)." } }, ["agent"]),
    async run(ctx, args) {
      try { return { ...(await ctx.agent.contacts.knock({ to: need(args, "agent", "which agent"), ...(str(args.via) ? { via: str(args.via) } : {}) })) }; } catch (e) { throw refusalOf(e); }
    },
  },
  {
    name: "review_knocks",
    description: "See who knocked on your door, then let them in or turn them away. With no action, lists who is waiting.",
    inputSchema: obj({
      action: { type: "string", enum: ["list", "admit", "block"], description: "list (the default), admit or block." },
      sender: agentArg,
      note: { type: "string", description: "A note kept with the decision." },
    }),
    async run(ctx, args) {
      await ctx.bridge.ensureInbox(ctx.key);
      const action = str(args.action) || "list";
      try {
        if (action === "list") return { ...(await ctx.agent.contacts.waiting()) };
        const sender = need(args, "sender", "who to let in or turn away");
        const note = str(args.note) || undefined;
        if (action === "admit") return { ...(await ctx.agent.contacts.admit({ sender, ...(note ? { note } : {}) })) };
        if (action === "block") return { ...(await ctx.agent.contacts.block({ sender, ...(note ? { note } : {}) })) };
      } catch (e) {
        throw refusalOf(e);
      }
      throw new ToolRefusal("INPUT_INVALID", "action is list, admit or block.");
    },
  },
  {
    name: "send",
    description: "Send a message to an agent. If it answers within about 20 seconds, its reply comes back here; otherwise the mesh keeps the message, and any reply arrives later in check_inbox.",
    inputSchema: obj({ to: { ...agentArg, description: "Who to send to: an agent id (U followed by 55 characters) or a name." }, text: { type: "string", description: "The message, at most 64 KB." } }, ["to", "text"]),
    async run(ctx, args) {
      const to = need(args, "to", "who to send to");
      const text = typeof args.text === "string" ? args.text : "";
      if (!text.trim()) throw new ToolRefusal("INPUT_INVALID", "Say the message (text).");
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT) throw new ToolRefusal("TOO_BIG", "A message takes at most 64 KB. Put anything longer in a room as a file.");
      if (!AGENT_ID.test(to)) {
        try {
          const r = await ctx.agent.messages.send({ to, text });
          if (r.request_id) remember(ctx.key, r.request_id, { to, status: r.delivered ? "answered" : "waiting", ...(r.reply !== undefined ? { reply: r.reply } : {}) });
          return { ...r };
        } catch (e) {
          throw refusalOf(e);
        }
      }
      try {
        const r = await ctx.agent.request(to, "chat", { text }, { timeout_ms: SEND_WAIT_S * 1000 });
        const p = (r.payload as { output?: unknown })?.output ?? r.payload;
        const reply = typeof p === "string" ? p : (p as { text?: unknown })?.text ?? p;
        const id = r.envelope.in_reply_to ?? undefined;
        if (id) remember(ctx.key, id, { to, status: "answered", reply });
        return { delivered: true, reply, ...(id ? { request_id: id } : {}) };
      } catch (e) {
        const err = e as { code?: string; message?: string; details?: { queued?: boolean; request_id?: string } };
        const id = err.details?.request_id;
        if (err.code === "REQUEST_QUEUED" || err.details?.queued === true) {
          if (id) remember(ctx.key, id, { to, status: "queued" });
          return { delivered: false, ...(id ? { request_id: id } : {}), note: "Sent. The agent's mailbox holds it; any reply arrives later in check_inbox." };
        }
        if (/timeout|no response/i.test(String(err.message ?? ""))) {
          if (id) remember(ctx.key, id, { to, status: "waiting" });
          return { delivered: false, ...(id ? { request_id: id } : {}), note: "Sent. The agent did not answer within 20 seconds; any reply arrives later in check_inbox." };
        }
        throw refusalOf(e);
      }
    },
  },
  {
    name: "check_inbox",
    description: "Read what has arrived for you: messages, replies to what you sent, and new values of the feeds you follow. Pass ids in dismiss to clear messages you are done with.",
    inputSchema: obj({ dismiss: { type: "array", items: { type: "string" }, description: "Inbox ids to clear." } }),
    async run(ctx, args) {
      await ctx.bridge.ensureInbox(ctx.key);
      try {
        const ids = Array.isArray(args.dismiss) ? args.dismiss.filter((x): x is string => typeof x === "string") : [];
        const dismissed = ids.length ? await ctx.agent.messages.dismiss({ inbox_ids: ids }) : null;
        const inbox = await ctx.agent.messages.inbox();
        const feeds: Array<Record<string, unknown>> = [];
        for (const f of followed.get(ctx.key) ?? []) {
          try { feeds.push({ ...f, ...(await ctx.agent.feeds.read({ target: f.target, topic: f.topic, limit: 5 })) }); } catch (e) { feeds.push({ ...f, error: refusalOf(e).message }); }
        }
        return { messages: inbox.messages, ...(feeds.length ? { feeds } : {}), ...(dismissed ? { dismissed } : {}) };
      } catch (e) {
        throw refusalOf(e);
      }
    },
  },
  {
    name: "reply",
    description: "Answer a message in your inbox, by its inbox id. The answer goes to the sender as a new message naming the one it answers.",
    inputSchema: obj({ inbox_id: { type: "string", description: "The message's id, as check_inbox lists it." }, text: { type: "string", description: "The answer, at most 64 KB." } }, ["inbox_id", "text"]),
    async run(ctx, args) {
      await ctx.bridge.ensureInbox(ctx.key);
      try { return { ...(await ctx.agent.messages.reply({ inbox_id: need(args, "inbox_id", "which message"), text: typeof args.text === "string" ? args.text : "" })) }; } catch (e) { throw refusalOf(e); }
    },
  },
  {
    name: "task_status",
    description: "Where a message you sent stands, by its request id from send: answered (with the reply), queued in the agent's mailbox, or waiting.",
    inputSchema: obj({ request_id: { type: "string", description: "The request id send gave back." } }, ["request_id"]),
    async run(ctx, args) {
      const id = need(args, "request_id", "which request");
      const rec = sent.get(ctx.key)?.get(id);
      if (!rec) throw new ToolRefusal("NOT_FOUND", "This bridge has no record of that request from you. Replies that arrive later are in check_inbox.");
      return { request_id: id, ...rec };
    },
  },
  {
    name: "publish",
    description: "Publish a value on one of your feeds: anyone who follows it sees the latest value.",
    inputSchema: obj({ topic: { type: "string", description: "The feed's name: letters, digits, - and _." }, data: { description: "The value: words or an object." } }, ["topic", "data"]),
    async run(ctx, args) {
      try { return { ...(await ctx.agent.feeds.publish({ topic: need(args, "topic", "the feed's name"), data: args.data })) }; } catch (e) { throw refusalOf(e); }
    },
  },
  {
    name: "follow",
    description: "Follow another agent's feed. Its new values show up in check_inbox.",
    inputSchema: obj({ agent: agentArg, topic: { type: "string", description: "The feed's name." } }, ["agent", "topic"]),
    async run(ctx, args) {
      const target = need(args, "agent", "whose feed");
      const topic = need(args, "topic", "which feed");
      try {
        const r = await ctx.agent.feeds.follow({ target, topic });
        const list = followed.get(ctx.key) ?? [];
        if (!list.some((f) => f.target === target && f.topic === topic)) list.push({ target, topic });
        followed.set(ctx.key, list.slice(-50));
        return { ...r };
      } catch (e) {
        throw refusalOf(e);
      }
    },
  },
  {
    name: "open_room",
    description: "Start a room: a shared conversation several agents can join. It keeps a record and a drive for files unless you ask for a passing one.",
    inputSchema: obj({ name: { type: "string", description: "A name members see." }, durable: { type: "boolean", description: "Keep a record and a drive (the default)." } }),
    async run(ctx, args) {
      const name = str(args.name) || undefined;
      try {
        return plain({ ...(await ctx.agent.rooms.open({ ...(name ? { name } : {}), durable: args.durable !== false })) });
      } catch (e) {
        throw refusalOf(e);
      }
    },
  },
  {
    name: "invite_to_room",
    description: "Bring another agent into one of your rooms.",
    inputSchema: obj({ room: { type: "string", description: "The room's id or name." }, agent: agentArg, note: { type: "string", description: "One or two lines for the agent you invite." } }, ["room", "agent"]),
    async run(ctx, args) {
      try {
        return plain({ ...(await ctx.agent.rooms.invite({ room: need(args, "room", "which room"), target: need(args, "agent", "who to invite"), ...(str(args.note) ? { note: str(args.note) } : {}) })) });
      } catch (e) {
        throw refusalOf(e);
      }
    },
  },
  {
    name: "post_to_room",
    description: "Post a message to a room, and a small file (up to 1 MB of text) with it if you like.",
    inputSchema: obj({
      room: { type: "string", description: "The room's id or name." },
      text: { type: "string", description: "The message." },
      file_name: { type: "string", description: "A file's name, such as notes.md." },
      file_text: { type: "string", description: "The file's text, up to 1 MB." },
    }, ["room", "text"]),
    async run(ctx, args) {
      const room = need(args, "room", "which room");
      const fileName = str(args.file_name);
      const fileText = typeof args.file_text === "string" ? args.file_text : "";
      if (fileName && Buffer.byteLength(fileText, "utf8") > MAX_FILE) throw new ToolRefusal("TOO_BIG", "A file takes at most 1 MB here.");
      try {
        const file = fileName ? await ctx.agent.rooms.attach({ room, name: fileName, content: fileText }) : null;
        const post = await ctx.agent.rooms.post({ room, text: typeof args.text === "string" ? args.text : "" });
        return plain({ ...post, ...(file ? { file: plain({ ...file }) } : {}) });
      } catch (e) {
        throw refusalOf(e);
      }
    },
  },
  {
    name: "read_room",
    description: "Read what has been said in a room.",
    inputSchema: obj({ room: { type: "string", description: "The room's id or name." } }, ["room"]),
    async run(ctx, args) {
      try { return plain({ ...(await ctx.agent.rooms.history({ room: need(args, "room", "which room") })) }); } catch (e) { throw refusalOf(e); }
    },
  },
];

export const TOOL_NAMES = BRIDGE_TOOLS.map((t) => t.name);

/** Run one tool by name. Throws ToolRefusal for anything a caller can act on. */
export async function runTool(ctx: ToolContext, name: string, args: unknown): Promise<Record<string, unknown>> {
  const tool = BRIDGE_TOOLS.find((t) => t.name === name);
  if (!tool) throw new ToolRefusal("UNKNOWN_TOOL", `There is no tool ${name}. The tools are ${TOOL_NAMES.join(", ")}.`);
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) throw new ToolRefusal("INPUT_INVALID", "A tool's arguments are a JSON object.");
  return tool.run(ctx, (args ?? {}) as Record<string, unknown>);
}
