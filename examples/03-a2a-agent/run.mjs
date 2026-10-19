// An existing A2A agent joins the mesh through the A2A gateway, unchanged.
// And the other way round: an A2A client reaches a mesh agent through the
// gateway, as if it were any A2A agent.
//
//   node examples/run.mjs nats 03        (needs the Compose setup's gateway)
//
// 1. The A2A agent (a2a-agent.mjs) runs beside the gateway. It knows nothing
//    of Agent Messaging: it serves an agent card and A2A's SendMessage.
// 2. The gateway's operator attaches it (POST /admin/attachments on the
//    gateway, which answers only callers on its own host). The gateway puts it
//    on the mesh as an agent with its own key.
// 3. A mesh agent sends it a request, and gets the A2A agent's answer.
// 4. A mesh agent opens itself to A2A callers, and a plain A2A client, holding
//    an API key the gateway's operator made, reads its card and sends it a
//    message through the gateway.

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, connect, enroll, run, say, sleep, tenant } from "../lib/mesh.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const composeFile = process.env.COMPOSE_FILE_PATH;
if (!composeFile) {
  console.error("Run it with examples/run.mjs, which names the Compose setup (COMPOSE_FILE_PATH).");
  process.exit(2);
}
const GATEWAY_URL = (process.env.GATEWAY_URL ?? "http://localhost:8090").replace(/\/+$/, "");
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
const docker = (args) => execFileSync("docker", args, { env, encoding: "utf8", timeout: 60_000 }).trim();

/** One call to the gateway's admin routes, from inside its container. */
function gatewayAdmin(method, path, body) {
  const code = `fetch("http://127.0.0.1:8090${path}",{method:${JSON.stringify(method)},headers:{"content-type":"application/json"},body:${body ? JSON.stringify(JSON.stringify(body)) : "undefined"}}).then(async(r)=>{process.stdout.write(JSON.stringify({status:r.status,body:await r.json().catch(()=>null)}))})`;
  return JSON.parse(docker(["compose", "-f", composeFile, "exec", "-T", "a2a-gateway", "node", "-e", code]));
}

const gatewayContainer = docker(["compose", "-f", composeFile, "ps", "-q", "a2a-gateway"]);
// The A2A agent runs on the gateway's own image, whichever one the setup started.
const image = process.env.GATEWAY_IMAGE ?? docker(["inspect", "-f", "{{.Config.Image}}", gatewayContainer]);
const agentName = `example-a2a-agent-${run}`;

// 1. The A2A agent, in the gateway's network, so the gateway reaches it at
//    http://localhost:18100. (An agent elsewhere is attached by its https URL.)
docker(["run", "-d", "--rm", "--name", agentName, "--network", `container:${gatewayContainer}`,
  "--mount", `type=bind,source=${resolve(HERE)},target=/ex,readonly`, "--entrypoint", "node", image, "/ex/a2a-agent.mjs"]);
let attachedId = null;
try {
  await sleep(1500);

  // 2. Attach it.
  const attached = gatewayAdmin("POST", "/admin/attachments", { url: "http://localhost:18100", label: "Headline Writer" });
  check(attached.status === 201 && attached.body?.agentId, `the gateway's operator attached the A2A agent; on the mesh it is ${attached.body?.agentId ?? JSON.stringify(attached).slice(0, 300)}`);
  attachedId = attached.body.id;
  const a2aOnMesh = attached.body.agentId;

  const team = await tenant(`newsroom-${run}`);
  const editor = await connect(await enroll(team, "editor"));
  let card = null;
  for (let i = 0; i < 20 && !card; i++) {
    card = (await editor.discover({ offering_id: "headline" })).agents?.find((a) => a.id === a2aOnMesh) ?? null;
    if (!card) await sleep(500);
  }
  check(Boolean(card), `a mesh agent finds the A2A agent by its skill, as "${card?.name}"`);

  // 3. A mesh agent asks it.
  const answer = await editor.request(a2aOnMesh, "headline", { sentence: "agents on different brokers now reach each other through one server." }, { timeout_ms: 30_000 });
  const said = JSON.stringify(answer.payload?.output ?? answer.payload);
  check(/Agents On Different Brokers/.test(said), `the A2A agent answered a mesh request: ${said.slice(0, 120)}`);

  // 4. The other way: a mesh agent open to A2A callers, and a plain A2A client.
  const desk = await connect(await enroll(team, "fact desk"));
  desk.onRequest("check", (input) => ({ verdict: "confirmed", claim: input }));
  await desk.register({
    name: "fact-desk",
    description: "Checks a claim.",
    visibility: "public",
    offerings: [{ id: "check", name: "Check", description: "Checks a claim." }],
    // Open to callers through the A2A gateway, with an API key.
    public: { access: { schemes: [{ id: "a2a-gateway", transport: "http", type: "apiKey", in: "header", name: "Authorization" }] } },
  });
  const key = gatewayAdmin("POST", "/admin/keys", { label: "example A2A client" });
  check(key.status === 201 && key.body?.key, "the gateway's operator made an API key for an A2A client (not shown)");
  const auth = { authorization: `Bearer ${key.body.key}` };

  let cardRes = null;
  for (let i = 0; i < 20; i++) {
    cardRes = await fetch(`${GATEWAY_URL}/agents/${desk.agentId}/.well-known/agent-card.json`, { headers: auth });
    if (cardRes.status === 200) break;
    await sleep(500);
  }
  const deskCard = await cardRes.json();
  check(cardRes.status === 200, `an A2A client read the mesh agent's card from the gateway ("${deskCard.name}")`);
  const rpc = await fetch(`${GATEWAY_URL}/agents/${desk.agentId}/rpc`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", messageId: `m-${run}`, parts: [{ text: "The server runs on NATS or on RabbitMQ." }] } } }),
  });
  const body = await rpc.json();
  check(rpc.status === 200 && JSON.stringify(body.result ?? "").includes("confirmed"), "the A2A client's message reached the mesh agent, and its answer came back over A2A");

  await Promise.all([editor.close(), desk.close()]);
  say("Done: an A2A agent on the mesh, and a mesh agent on A2A.");
} finally {
  if (attachedId) gatewayAdmin("DELETE", `/admin/attachments/${attachedId}`);
  // What the A2A agent itself saw, then stop it.
  try { console.log(docker(["logs", agentName])); docker(["rm", "-f", agentName]); } catch { /* already gone */ }
}
process.exit(0);
