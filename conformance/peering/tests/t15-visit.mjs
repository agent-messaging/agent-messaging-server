// §21.14 to §21.20: a visit. An agent whose home is mesh A reaches an agent
// on mesh B by asking B for a pass and connecting there, with no arrangement
// between the two meshes' operators.
//
// Runs on the two meshes rig/visit-meshes.sh starts (export what `up` prints:
// PEER_VISIT_A_API, PEER_VISIT_A_HOME, PEER_VISIT_A_TOKEN_FILE,
// PEER_VISIT_B_API, PEER_VISIT_B_TOKEN_FILE, PEER_VISIT_NAMING_PORT,
// PEER_VISIT_NAMING_URL), with a naming service this
// test runs itself: it signs both agents' cards, A's agent naming A as its
// home and B's agent naming B. What it shows, in order:
//   1. B issues a pass only after A says it holds the visitor's key, and the
//      visitor connects to B under it (§21.15 to §21.17);
//   2. at B's agent's door the visitor is a stranger with a verified
//      identity: what it sends is held, never dropped as anonymous, its knock
//      reaches the owner, and once let in it is answered (§21.18);
//   3. an answer sent after the visitor left waits on B and arrives on its
//      next visit (§21.19);
//   4. the pass cannot register the visitor as one of B's agents (§21.17);
//   5. an agent A holds no account for is refused a pass (§21.16).
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sdkModule, canonicalJSON } from "../lib/sdk.mjs";

const require = createRequire(import.meta.url);
const nkeys = require("nkeys.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token(file) {
  const line = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!line) throw new Error(`${file} holds no admin token`);
  return line.split(/\s+/).pop();
}

async function admin(api, tok, method, path, body) {
  const r = await fetch(`${api}/admin/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

/** An agent enrolled on one mesh: a tenant, a one-time key, the bootstrap door. */
async function enroll(api, tok, tenant, label) {
  const { createAgentIdentity, exchangeBootstrapToken } = sdkModule;
  const t = await admin(api, tok, "POST", "/tenants", { id: tenant });
  if (![200, 201, 409].includes(t.status)) throw new Error(`tenant ${tenant}: ${t.status} ${JSON.stringify(t.json)}`);
  const k = await admin(api, tok, "POST", `/tenants/${encodeURIComponent(tenant)}/enroll-keys`, { label });
  if (k.status !== 201) throw new Error(`enroll key for ${label}: ${k.status} ${JSON.stringify(k.json)}`);
  const me = createAgentIdentity();
  const creds = await exchangeBootstrapToken(api, k.json.key, me.publicKey);
  return { id: me.publicKey, seed: me.seed, jwt: creds.jwt, credentialSeed: creds.seed, mesh: creds.mesh };
}

/** A naming service on this machine that signs the cards it is given. */
async function namingService(port) {
  const kp = nkeys.createAccount();
  const cards = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://naming");
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/api/registrar-key") return send(200, { keys: [kp.getPublicKey()] });
    if (url.pathname === "/api/resolve") {
      const card = cards.get(url.searchParams.get("handle"));
      if (!card) return send(404, { error: "not found" });
      const sig = Buffer.from(kp.sign(new TextEncoder().encode(canonicalJSON(card)))).toString("base64");
      return send(200, { ok: true, card, registrar_key: kp.getPublicKey(), registrar_sig: sig });
    }
    send(404, { error: "not found" });
  });
  await new Promise((ok, no) => { server.once("error", no); server.listen(port, "0.0.0.0", ok); });
  return {
    card(handle, agentId, mesh) {
      cards.set(handle, {
        handle,
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        endpoints: [{ protocol: "agentmesh", agent_id: agentId, mesh, node: null }],
      });
    },
    resolve: (handle) => cards.get(handle),
    close: () => new Promise((ok) => server.close(ok)),
  };
}

/** The rig's settings, read by exact name. Null when the rig is not running. */
function visitRig(e = process.env) {
  if (!e.PEER_VISIT_A_API || !e.PEER_VISIT_B_API) return null;
  const port = Number(e.PEER_VISIT_NAMING_PORT ?? 3099);
  return {
    aApi: e.PEER_VISIT_A_API,
    aHome: e.PEER_VISIT_A_HOME ?? e.PEER_VISIT_A_API,
    aTokenFile: e.PEER_VISIT_A_TOKEN_FILE ?? null,
    bApi: e.PEER_VISIT_B_API,
    bTokenFile: e.PEER_VISIT_B_TOKEN_FILE ?? null,
    namingPort: port,
    namingUrl: e.PEER_VISIT_NAMING_URL ?? `http://localhost:${port}`,
  };
}

export default {
  id: "t15",
  title: "a visit: an agent of one mesh reaches an agent on another",
  spec: "SPEC.md §21.14 to §21.20",
  profile: "platform",
  async run() {
    const v = visitRig();
    if (!v) return { status: "pending-peer", detail: "start the two meshes with rig/visit-meshes.sh up and export what it prints (PEER_VISIT_*)" };
    if (!v.aTokenFile || !v.bTokenFile) throw new Error("env-skip: PEER_VISIT_A_TOKEN_FILE and PEER_VISIT_B_TOKEN_FILE (each mesh's admin token)");
    const { AgentMesh, jwtAuthenticator, transportFromMesh, homeMeshOf, VisitRefused } = sdkModule;
    if (typeof AgentMesh.visit !== "function") return { status: "fail", detail: "the SDK under test has no AgentMesh.visit" };
    const aTok = token(v.aTokenFile);
    const bTok = token(v.bTokenFile);
    const run = Date.now().toString(36);
    const problems = [];
    const naming = await namingService(v.namingPort);
    const open = [];
    try {
      // The visitor's home is A; the agent it reaches lives on B.
      const visitor = await enroll(v.aApi, aTok, `home-${run}`, "visitor");
      const host = await enroll(v.bApi, bTok, `host-${run}`, "host agent");
      const vHandle = `visitor-${run}.alice@example.test`;
      const hHandle = `host-${run}.bob@example.test`;
      naming.card(vHandle, visitor.id, v.aHome);
      naming.card(hHandle, host.id, v.bApi);

      // B's agent keeps a door: strangers are held until it lets them in.
      const where = transportFromMesh(host.mesh);
      const h = await AgentMesh.connect(where.servers, {
        nkeySeed: host.seed,
        authenticator: jwtAuthenticator(host.jwt, new TextEncoder().encode(host.credentialSeed)),
        platformApi: v.bApi,
        requireNamed: false,
      });
      open.push(h);
      await h.admission.start({ inbox: true });
      await h.register({
        name: `host-${run}`, description: "Takes questions.", visibility: "public",
        public: { summary: "Takes questions." }, offerings: [{ id: "chat", name: "Chat", description: "Ask." }], guarded: true,
      });

      // 1. Read where (rule 14), then visit.
      const home = homeMeshOf(naming.resolve(hHandle), host.id);
      if (home !== new URL(v.bApi).origin) problems.push(`the host's card should name B as its home, got ${home}`);
      const answers = [];
      let guest = await AgentMesh.visit({ mesh: home, nkeySeed: visitor.seed, handle: vHandle, registrar: v.namingUrl });
      open.push(guest);
      guest.onRequest("chat", (input) => { answers.push(input); return { ok: true }; });
      if (guest.visitPass?.home_mesh !== new URL(v.aHome).origin) problems.push(`the pass should name the visitor's home as A, got ${guest.visitPass?.home_mesh}`);

      // 2. A stranger with a verified identity, at the host's door.
      const card = await guest.describe(host.id);
      if (card?.public?.summary !== "Takes questions.") problems.push(`describe across meshes: ${JSON.stringify(card?.public)}`);
      const sent = await guest.messages.send({ to: host.id, text: "Hello from mesh A" });
      if (sent.delivered !== false) problems.push(`a stranger's first message should be held, got ${JSON.stringify(sent)}`);
      await guest.contacts.knock({ to: host.id, via: "t15" });
      let waiting = [];
      for (let i = 0; i < 30 && !waiting.find((s) => s.agent_id === visitor.id); i++) { await sleep(200); waiting = (await h.contacts.waiting()).senders; }
      const asked = waiting.find((s) => s.agent_id === visitor.id);
      if (asked?.said !== "Hello from mesh A") problems.push(`the host should see the visitor waiting with what it said (held, not dropped as anonymous): ${JSON.stringify(waiting)}`);
      const admitted = await h.contacts.admit({ sender: visitor.id, note: "from mesh A" });
      if (admitted.released !== 1) problems.push(`letting the visitor in should release its message: ${JSON.stringify(admitted)}`);
      const msg = (await h.messages.inbox()).messages.find((m) => m.from === visitor.id);
      if (msg?.text !== "Hello from mesh A") problems.push("the released message should be in the host's inbox");

      // 3. The visitor leaves; the answer waits on B for its next visit.
      await guest.close();
      open.pop();
      const reply = msg ? await h.messages.reply({ inbox_id: msg.id, text: "Hello back, from mesh B" }) : null;
      if (reply && reply.delivered === true) problems.push("the answer should wait for the visitor, which is away");
      guest = await AgentMesh.visit({ mesh: home, nkeySeed: visitor.seed, handle: vHandle, registrar: v.namingUrl });
      open.push(guest);
      guest.onRequest("chat", (input) => { answers.push(input); return { ok: true }; });
      for (let i = 0; i < 50 && !answers.length; i++) await sleep(200);
      if (!String(answers[0]?.text ?? "").includes("Hello back, from mesh B")) problems.push(`the answer sent while the visitor was away should arrive on its next visit, got ${JSON.stringify(answers)}`);

      // 4. A pass does not make the visitor one of B's agents.
      const registered = await Promise.race([
        guest.register({ name: "squatter", description: "x", visibility: "public", offerings: [] }).then(() => true, () => false),
        sleep(8000).then(() => false),
      ]);
      if (registered) problems.push("a visitor's pass registered it on B");

      // 5. A key its home holds no account for gets no pass.
      const stray = sdkModule.createAgentIdentity();
      const sHandle = `stray-${run}.eve@example.test`;
      naming.card(sHandle, stray.publicKey, v.aHome);
      const refused = await AgentMesh.visit({ mesh: home, nkeySeed: stray.seed, handle: sHandle, registrar: v.namingUrl }).then(
        (m) => { open.push(m); return null; },
        (e) => e,
      );
      if (!(refused instanceof VisitRefused) || refused.code !== "visitor_not_in_standing") {
        problems.push(`an agent A holds no account for should be refused visitor_not_in_standing, got ${refused?.code ?? refused}`);
      }
    } finally {
      for (const m of open) await m.close().catch(() => {});
      await naming.close();
    }
    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : { status: "pass", detail: "an agent of mesh A visited mesh B: pass after its home vouched, held then let in at the door, a late answer on its next visit, no registration, and a stranger to A refused" };
  },
};
