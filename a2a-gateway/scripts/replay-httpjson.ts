/**
 * Local replay for the HTTP+JSON binding (BRIDGE-A2A.md §13), run before any
 * live check on dev. It starts the gateway's real HTTP surface on a free port
 * with a stand-in mesh (no NATS), then replays recorded traffic through it:
 *
 *   - the A2A 1.0 specification's own example requests (§11.2, §11.4, §11.5);
 *   - when REF_CLIENT points at PACT's reference client source
 *     (packages/client/src/index.ts of openpactprotocol/openpactprotocol), a
 *     real third-party HTTP+JSON client sending to the gateway.
 *
 * Usage (from a2a-gateway/):
 *   REF_CLIENT=<path to packages/client/src/index.ts> npx tsx scripts/replay-httpjson.ts
 *
 * Prints one line per case and exits 1 if any case fails. Touches no network
 * beyond 127.0.0.1.
 */
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { fakeConnect, manifestFixture } from "../__tests__/helpers.js";

const KEY = "replay-key";
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function main(): Promise<void> {
  const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, apiKeys: { [KEY]: "replay" } });
  const mesh = fakeConnect(bridge, {
    discover: async () => ({ agents: [manifestFixture()], total: 1 }),
    getManifest: async (id) => {
      if (id !== "UAGENTPUBKEY") throw new Error("no such agent");
      return manifestFixture();
    },
  });
  let turn = 0;
  mesh.answer = (req) => {
    turn++;
    const text = (req.input as { text?: string }).text ?? "";
    if (text.includes("defer")) return { task_id: `task-${turn}`, payload: { status: "working" }, envelope: { id: `env-${turn}` } };
    return { task_id: null, payload: { status: "completed", output: { text: `echo: ${text}` } }, envelope: { id: `env-${turn}` } };
  };
  const server = await startInboundServer(bridge);
  const port = (server.address() as AddressInfo).port;
  const iface = `http://127.0.0.1:${port}/agents/UAGENTPUBKEY`;
  const auth = { Authorization: `Bearer ${KEY}` };

  // A2A §11.2's example: application/a2a+json, A2A-Version and A2A-Extensions headers.
  {
    const res = await fetch(`${iface}/message:send`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/a2a+json", "A2A-Version": "1.0", "A2A-Extensions": "https://example.com/extensions/geolocation/v1" },
      body: JSON.stringify({ message: { role: "ROLE_USER", parts: [{ text: "Find restaurants near me" }] } }),
    });
    const body = (await res.json()) as { message?: { role: string; parts: Array<{ text: string }> } };
    check("A2A 11.2 example send", res.status === 200 && body.message?.role === "ROLE_AGENT" && body.message.parts[0].text === "echo: Find restaurants near me", `${res.status}`);
  }

  // A2A §11.4's example: messageId and configuration.acceptedOutputModes.
  {
    const res = await fetch(`${iface}/message:send`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/a2a+json" },
      body: JSON.stringify({ message: { messageId: "uuid", role: "ROLE_USER", parts: [{ text: "Hello" }] }, configuration: { acceptedOutputModes: ["text/plain"] } }),
    });
    check("A2A 11.4 example send", res.status === 200 && res.headers.get("content-type") === "application/a2a+json", `${res.status}`);
  }

  // A deferred task, then A2A §11.5's GET with historyLength.
  {
    const res = await fetch(`${iface}/message:send`, { method: "POST", headers: auth, body: JSON.stringify({ message: { role: "ROLE_USER", parts: [{ text: "defer this" }] } }) });
    const body = (await res.json()) as { task?: { id: string; status: { state: string } } };
    check("deferred task state is an enum", body.task?.status.state === "TASK_STATE_WORKING", body.task?.status.state);
    const read = await fetch(`${iface}/tasks/${body.task?.id}?historyLength=10`, { headers: { ...auth, "A2A-Version": "1.0" } });
    const task = (await read.json()) as { id?: string; status?: { state: string } };
    check("A2A 11.5 example GET tasks/{id}?historyLength=10", read.status === 200 && task.id === body.task?.id, `${read.status}`);
  }

  // A2A §11.5's list example: the gateway does not list tasks (§4.2).
  {
    const res = await fetch(`${iface}/tasks?contextId=uuid&status=TASK_STATE_WORKING&pageSize=50&pageToken=cursor`, { headers: auth });
    const body = (await res.json()) as { error?: { details: Array<{ reason: string }> } };
    check("A2A 11.5 example list is UNSUPPORTED_OPERATION", res.status === 400 && body.error?.details[0].reason === "UNSUPPORTED_OPERATION", `${res.status}`);
  }

  // A2A §11.6's example: TASK_NOT_FOUND envelope.
  {
    const res = await fetch(`${iface}/tasks/task-123`, { headers: auth });
    const body = (await res.json()) as { error?: { code: number; status: string; details: Array<{ "@type": string; reason: string; domain: string }> } };
    check(
      "A2A 11.6 example TASK_NOT_FOUND",
      res.status === 404 && body.error?.code === 404 && body.error.status === "NOT_FOUND" && body.error.details[0]["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" && body.error.details[0].domain === "a2a-protocol.org",
      `${res.status}`,
    );
  }

  // The PACT reference client, a third party's HTTP+JSON client.
  const refPath = process.env.REF_CLIENT;
  if (refPath) {
    const ref = (await import(pathToFileURL(refPath).href)) as {
      A2AClient: new (o: { url: string; getToken: () => string }) => { sendMessage(text: string, o?: { contextId?: string }): Promise<{ role: string; parts: Array<{ text?: string }> }> };
    };
    const client = new ref.A2AClient({ url: iface, getToken: () => KEY });
    const reply = await client.sendMessage("Where is my order?");
    check("reference client sendMessage", reply.role === "ROLE_AGENT" && reply.parts[0]?.text === "echo: Where is my order?", JSON.stringify(reply.parts));
    const sent = mesh.requests.at(-1);
    check("reference client's message reached the mesh as {text}", (sent?.input as { text?: string })?.text === "Where is my order?");
  } else {
    console.log("SKIP  reference client (REF_CLIENT not set)");
  }

  server.closeAllConnections?.();
  server.close();
  console.log(failures ? `${failures} failed` : "all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
