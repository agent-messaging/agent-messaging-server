// A company's identity provider, two ways onto the mesh: one agent enrolls
// natively with a DPoP-bound OAuth token, and an assistant that holds no mesh
// key reaches the mesh through the identity bridge's MCP front with its own
// token, and uses every one of the bridge's sixteen tools.
//
//   node examples/08-oauth-native-and-bridged/run.mjs
//
// It needs the mesh started with MESH_TRUST_ALLOW_HTTP=on, because the
// example's issuer runs over http on this machine; without it the example
// says so and is skipped. A real identity provider is https.

import { ExampleIssuer } from "../lib/issuer.mjs";
import { MESH_API, admin, check, connect, enroll, run, say, sdk, sleep, tenant } from "../lib/mesh.mjs";

const GATEWAY = (process.env.GATEWAY_URL ?? "http://localhost:8090").replace(/\/+$/, "");
const MCP = `${GATEWAY}/mcp`;
const issuer = await new ExampleIssuer().start();
let native = null;
try {
  // The operator: Acme's tenant trusts Acme's identity provider, and only for
  // tokens bound to a key the caller proves it holds (DPoP, RFC 9449).
  const acme = await tenant(`acme-oauth-${run}`);
  const added = await admin("POST", `/tenants/${acme}/trust`, { kind: "oauth", issuer: issuer.base, audience: MESH_API, require_binding: true });
  if (added.status === 400 && /https/.test(JSON.stringify(added.json))) {
    say("Skipped: this mesh fetches keys only from https:// issuers. Start it with MESH_TRUST_ALLOW_HTTP=on to run this example's http issuer.");
    process.exit(3);
  }
  check(added.status === 201, "Acme's tenant trusts its identity provider, for bound tokens only (mesh-admin tenants trust add --oauth ... --require-binding)");

  // 1. Native: the agent holds a DPoP key, gets a token bound to it, makes its
  //    own key pair and enrolls with the token in place of an enrollment key.
  const dpop = await sdk.generateDpopKey();
  const me = sdk.createAgentIdentity();
  const creds = await sdk.exchangeOutsideProof(MESH_API, me.publicKey, { kind: "oauth", token: issuer.token("acme-purchasing", MESH_API, dpop.jkt), dpopKey: dpop.privateJwk });
  check(creds.identity_source?.kind === "oauth" && creds.identity_source.workload_id === "acme-purchasing", "the purchasing agent enrolled natively with its DPoP-bound token");
  native = await connect(
    { id: me.publicKey, seed: me.seed, jwt: creds.jwt, credentialSeed: creds.seed, mesh: creds.mesh },
    // It renews only with a fresh proof of the same identity (§4.14).
    { jwt: creds.jwt, credentialRenewal: { apiBase: MESH_API, credentialSeed: creds.seed, proof: () => ({ kind: "oauth", token: issuer.token("acme-purchasing", MESH_API, dpop.jkt), dpopKey: dpop.privateJwk }) } },
  );
  const heard = [];
  native.onRequest("chat", (input, ctx) => { heard.push(ctx.envelope); return { text: `Purchasing heard: ${input.text}` }; });
  await native.register({ name: `acme-purchasing-${run}`, description: "Acme's purchasing agent.", visibility: "public", offerings: [{ id: "chat", name: "Chat", description: "Talk to purchasing." }] });
  // It keeps a door: native agents are let in, bridged ones wait (EXT-6 0.5.0).
  await native.admission.start({ registered: "allow", bridged: "hold" });
  native.publishFeed("status", { open_orders: 3 }, { kind: "state" });
  await native.renewCredential();
  check(true, "it renewed its credential with a fresh bound token");

  // 2. Bridged: an assistant with no mesh key calls the bridge's MCP front.
  //    Its token names the front (RFC 8707) and is bound to its own DPoP key;
  //    each request carries a fresh DPoP proof. No tool takes the token.
  const aKey = await sdk.generateDpopKey();
  const aToken = issuer.token("acme-assistant", MCP, aKey.jkt);
  let id = 0;
  const mcp = async (method, params) => {
    const proof = await sdk.createDpopProof({ method: "POST", url: MCP, accessToken: aToken, privateJwk: aKey.privateJwk });
    const res = await fetch(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `DPoP ${aToken}`, dpop: proof, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  const tool = async (name, args = {}) => {
    const r = await mcp("tools/call", { name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
    return r.structuredContent;
  };
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "example-08", version: "1" } });
  check(!!init.capabilities?.tools, `the MCP front answered initialize (protocol ${init.protocolVersion})`);
  const listed = await mcp("tools/list", {});
  check(listed.tools.length === 16, `it offers ${listed.tools.length} tools: ${listed.tools.map((t) => t.name).join(", ")}`);

  const who = await tool("whoami");
  check(who.caller_kind === "oauth" && who.tenant === acme && who.bound_to_key, "whoami: the assistant is Acme's, by its OAuth token, bound to its key");
  const found = await tool("find_agents", { text: "purchasing" });
  check(found.agents.some((a) => a.agent_id === me.publicKey && a.identity_source === "oauth"), "find_agents finds the purchasing agent, enrolled through Acme's identity provider");
  const card = await tool("describe_agent", { agent: me.publicKey });
  check(card.identity_source?.kind === "oauth", "describe_agent reads its card without bothering it");
  const online = await tool("is_online", { agent: me.publicKey });
  check(JSON.stringify(online).includes(me.publicKey), "is_online asks whether it is there");
  await tool("knock", { agent: me.publicKey, via: "example 08" });
  const knocked = await native.contacts.waiting();
  check(knocked.senders.some((s) => s.agent_id === who.agent_id), "knock: the assistant waits at the purchasing agent's door, as a bridged sender does");
  // The purchasing agent lets in every agent whose identity came from Acme's
  // identity provider, bridged or not: one entry for the source.
  await native.contacts.admit({ source: `oauth:${issuer.base}` });
  check(true, "the purchasing agent admits the source oauth:<Acme's issuer> (contacts.admit({ source }))");
  const sent = await tool("send", { to: me.publicKey, text: "Order 40 gaskets." });
  check(/heard/.test(JSON.stringify(sent.reply)), "send: the purchasing agent answered");
  const marker = heard.at(-1)?.meta?.identity_bridge;
  check(marker?.caller_kind === "oauth" && marker.front === "mcp" && !("tenant" in marker), "the message it got says it came through the bridge, by MCP, and names no account");
  const status = await tool("task_status", { request_id: sent.request_id });
  check(status.status === "answered", "task_status: answered");

  // The assistant keeps a door too. A stranger from another company knocks;
  // the assistant sees it waiting and lets it in.
  const stranger = await connect(await enroll(await tenant(`globex-${run}`), "globex sales"));
  await stranger.register({ name: `globex-sales-${run}`, description: "Globex sales.", visibility: "unlisted", offerings: [] });
  await stranger.contacts.knock({ to: who.agent_id, via: "a trade fair" });
  await sleep(1000);
  const waiting = await tool("review_knocks", { action: "list" });
  check(waiting.senders.some((s) => s.agent_id === stranger.agentId), "review_knocks: Globex's agent is waiting at the assistant's door");
  await tool("review_knocks", { action: "admit", sender: stranger.agentId });
  await stranger.close();

  // The purchasing agent writes back with the order number. The assistant
  // wrote to it first, so it goes straight to the assistant's inbox.
  await native.request(who.agent_id, "chat", { text: "Your order number is 1017." }).catch(() => null);
  await sleep(1500);
  const inbox = await tool("check_inbox");
  const msg = inbox.messages.find((m) => m.from === me.publicKey);
  check(!!msg, "check_inbox: its message is in the assistant's inbox");
  await tool("reply", { inbox_id: msg.id, text: "Thanks, noted." });
  await sleep(1000);
  check(heard.some((e) => e.payload?.input?.in_reply_to === msg.id || JSON.stringify(e.payload ?? {}).includes(msg.id)), "reply: the answer reached the purchasing agent, naming its message");

  await tool("publish", { topic: "assistant-status", data: "on duty" });
  check(true, "publish: the assistant published on its own feed");
  await tool("follow", { agent: me.publicKey, topic: "status" });
  const later = await tool("check_inbox", { dismiss: [msg.id] });
  check((later.feeds ?? []).some((f) => f.topic === "status"), "follow: the purchasing agent's status feed shows up in check_inbox");

  const room = await tool("open_room", { name: `acme-orders-${run}` });
  check(!!room.room_id, "open_room: a room for the order");
  await tool("invite_to_room", { room: room.room_id, agent: me.publicKey, note: "About order 1017." });
  await tool("post_to_room", { room: room.room_id, text: "Order 1017: 40 gaskets.", file_name: "order-1017.md", file_text: "# Order 1017\n\n40 gaskets." });
  const read = await tool("read_room", { room: room.room_id });
  check(JSON.stringify(read).includes("Order 1017"), "invite_to_room, post_to_room and read_room: the post is in the room's record");
  say("Done: one identity provider, a native agent and a bridged assistant, and every tool of the MCP front.");
} finally {
  await native?.close().catch(() => {});
  issuer.close();
}
