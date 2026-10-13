// Two agents in different companies message each other, including while one
// of them is offline.
//
//   node examples/01-two-companies/run.mjs
//
// Acme's buyer asks Globex's quoting agent for a price. First while the quoting
// agent is online; then while it is away. The second request waits in the
// quoting agent's mailbox on the mesh, and the answer reaches the buyer when
// the quoting agent comes back.

import { check, connect, enroll, run, say, sleep, tenant } from "../lib/mesh.mjs";

const acme = await tenant(`acme-${run}`);
const globex = await tenant(`globex-${run}`);
say(`Two companies on one mesh: tenants ${acme} and ${globex}.`);

const buyer = await enroll(acme, "acme buyer");
const quoter = await enroll(globex, "globex quoting agent");

/** Globex's quoting agent: answers "quote" with a price. */
async function startQuoter() {
  const mesh = await connect(quoter);
  mesh.onRequest("quote", (input) => ({ item: input.item, price_usd: 42 * (input.quantity ?? 1), quoted_by: "globex" }));
  await mesh.register({
    name: "globex-quotes",
    description: "Quotes prices for Globex parts.",
    visibility: "public",
    offerings: [{ id: "quote", name: "Quote", description: "A price for an item and a quantity." }],
  });
  return mesh;
}

const buyerMesh = await connect(buyer);
let quoterMesh = await startQuoter();
say("Both agents are connected and the quoting agent is registered.");

// 1. Online.
const live = await buyerMesh.request(quoter.id, "quote", { item: "flange", quantity: 2 }, { timeout_ms: 15_000 });
check(live.payload?.output?.price_usd === 84, `Acme's buyer asked Globex's agent across companies and got a price (${JSON.stringify(live.payload?.output)})`);

// 2. Offline: the quoting agent goes away, the buyer asks anyway.
await quoterMesh.close();
say("The quoting agent is offline now. The buyer sends a request anyway.");
const asked = Date.now();
const pending = buyerMesh.request(quoter.id, "quote", { item: "gasket", quantity: 10 }, { timeout_ms: 60_000 });

await sleep(4000);
say("Four seconds later the quoting agent comes back, and finds the request in its mailbox.");
quoterMesh = await startQuoter();

const late = await pending;
check(late.payload?.output?.price_usd === 420, `the request sent while it was away was answered when it returned, ${((Date.now() - asked) / 1000).toFixed(1)} s after it was sent (${JSON.stringify(late.payload?.output)})`);

await buyerMesh.close();
await quoterMesh.close();
say("Done: store and forward between two companies.");
process.exit(0);
