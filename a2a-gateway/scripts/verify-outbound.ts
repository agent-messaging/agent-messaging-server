/**
 * Verify the outbound direction from the mesh side: discover the bridged
 * agent (provenance marker present), then request through it — the full loop
 * mesh -> bridge -> HTTP A2A -> bridge inbound -> mesh -> real agent -> back.
 *   npx tsx scripts/verify-outbound.ts
 */
import { MeshNode } from "../../sdk-typescript/src/node.js";
import { BRIDGE_EXTENSION_URI } from "../src/core/card.js";

const NATS_URL = process.env.MESH_URL ?? "ws://localhost:4443";

async function main(): Promise<void> {
  const node = await MeshNode.connect(NATS_URL);
  const me = node.addAgent();

  const { agents } = await me.discover({ limit: 50 });
  const bridged = agents.filter((m) =>
    m.extensions?.some((e) => e.uri === BRIDGE_EXTENSION_URI),
  );
  console.log(`discovered ${agents.length} agents, ${bridged.length} bridged:`);
  for (const m of bridged) {
    const marker = (m.meta?.a2a_bridge ?? {}) as Record<string, unknown>;
    console.log(`  - ${m.name} (${m.id.slice(0, 12)}...) direction=${marker.direction} endpoint=${marker.endpoint}`);
  }
  if (bridged.length === 0) throw new Error("no bridged agent found in discovery");

  // Stale registrations (from a killed bridge that never deregistered) may
  // linger; try each bridged agent until one answers.
  let verified = false;
  for (const target of bridged) {
    try {
      const result = await me.request(target.id, "echo", { via: "full A2A loop" }, { timeout_ms: 15_000 });
      console.log(`request to ${target.id.slice(0, 12)}...: ${result.payload.status}`);
      console.log("request output:", JSON.stringify(result.payload.output));
      const out = result.payload.output as { echoed?: unknown };
      if (result.payload.status === "completed" && out && JSON.stringify(out.echoed) === JSON.stringify({ via: "full A2A loop" })) {
        verified = true;
        break;
      }
    } catch (err) {
      console.log(`request to ${target.id.slice(0, 12)}... failed (stale?): ${(err as Error).message}`);
    }
  }
  if (!verified) throw new Error("no bridged agent completed the round trip");
  console.log("OUTBOUND LOOP VERIFIED");
  await node.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("verify failed:", err);
  process.exit(1);
});
