/**
 * Local test fixture for the bridge: a keyless (dev) mesh agent with a plain
 * skill and a streaming skill. Run against an open local NATS:
 *   npx tsx scripts/test-agent.ts
 */
import { MeshNode } from "../../sdk-typescript/src/node.js";

const NATS_URL = process.env.MESH_URL ?? "ws://localhost:4443";

async function main(): Promise<void> {
  const node = await MeshNode.connect(NATS_URL, {
    profile: { availability_class: "always_on", reachability: "direct" },
  });
  node.startHeartbeat();
  const agent = node.addAgent();

  agent.onRequest("echo", (input) => ({
    echoed: input,
    agent: agent.id,
  }));

  agent.onStreamRequest("count", async (input, _ctx, writer) => {
    const n = Math.min(Number((input as { to?: number })?.to ?? 3), 10);
    for (let i = 1; i <= n; i++) {
      if (i === n) writer.end({ text: `${i} (done)` });
      else writer.write({ text: String(i) });
    }
  });

  await agent.register({
    name: "Bridge Test Agent",
    description: "Echo + streaming counter, for bridge e2e tests",
    version: "1.0.0",
    capabilities: ["echo", "testing"],
    skills: [
      { id: "echo", name: "Echo", description: "Returns the input unchanged" },
      { id: "count", name: "Count", description: "Streams numbers 1..to", streaming: true },
    ],
    provider: { name: "AgentMesh" },
  });

  console.log(`[test-agent] registered: ${agent.id}`);
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[test-agent] fatal:", err);
  process.exit(1);
});
