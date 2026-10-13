/**
 * One-shot admin sweep: purge registry KV entries whose key is not a valid
 * agent NKey public key. Early protocol versions used UUID agent IDs; those
 * registrations can never be deregistered through the protocol (deregister
 * requires the agent's signature, and a UUID cannot sign), so they linger in
 * the KV forever and inflate discovery counts.
 *
 * Run on the mesh host (same env as services):
 *   NATS_URL=localhost:4222 npx tsx src/scripts/purge-stale-registry.ts
 * Add --dry-run to only report. Restart agentmesh-services afterwards so the
 * in-memory manifest cache reloads.
 */
// The server's own maintenance (step 10a: it reaches the registry's store
// through the storage layer, like the registry itself).
import { connectMesh } from "../storage/index.js";

const AGENT_KEY_RE = /^U[A-Z2-7]{55}$/;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const mesh = await connectMesh({ binding: process.env.MESH_BROKER, servers: process.env.NATS_URL ?? "localhost:4222", credsFile: process.env.NATS_CREDS });
  const kv = await mesh.storage.keyed("mesh_registry");

  // Enumerate with `snapshotKvBucket`, which throws rather than returning a short
  // list, and which brings each value back with its key so the `name` below needs
  // no second read.
  //
  // The comment that used to sit here blamed "an ordered consumer with an
  // inactivity timeout" and mitigated it by draining the key list before the slow
  // calls. Both halves were wrong. The cause is a producer/consumer race inside
  // `kv.keys()` — it drains a subscription in a detached loop and pushes into a
  // second iterator whose `iterate()` discards anything appended while the caller
  // was awaiting the previous batch (shared/kv.ts documents it, with numbers) —
  // and draining first only removes the caller's per-key work from that race, not
  // the race: it measured 432 keys of 500 rather than 1 of 500. Nothing times out
  // and no error is raised either way.
  //
  // This script's failure direction was the safe one, which is why it survived:
  // it purges keys that do NOT match the agent-key pattern, so a short read
  // under-purges and leaves stale rows for the next run. It is migrated anyway —
  // the scanned/purged totals it prints were being quietly understated, and "run
  // it again" is not a property anyone verified.
  const snapshot = await kv.list();

  let total = 0;
  let purged = 0;
  for (const [key, entry] of snapshot.entries) {
    total++;
    if (AGENT_KEY_RE.test(key)) continue;
    let name = "?";
    try {
      name = (entry.json() as { name?: string })?.name ?? "?";
    } catch { /* unparseable is also purge-worthy */ }
    console.log(`${dryRun ? "[dry-run] would purge" : "purging"}: ${key} (name: ${name})`);
    if (!dryRun) await kv.purge(key);
    purged++;
  }

  console.log(`\n${total} entries scanned, ${purged} ${dryRun ? "stale (dry run, nothing deleted)" : "purged"}.`);
  if (!dryRun && purged > 0) {
    console.log("Restart agentmesh-services so the registry cache reloads.");
  }
  await mesh.drain();
  process.exit(0);
}

main().catch((err) => {
  console.error("purge failed:", err);
  process.exit(1);
});
