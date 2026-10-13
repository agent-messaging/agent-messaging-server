// An agent that enrolls with the identity its platform already gave it: a
// SPIFFE JWT-SVID from SPIRE, in place of an enrollment key.
//
//   node examples/07-spiffe-jwt-svid/run.mjs
//
// A SPIRE server is the authority of the trust domain example.org. The mesh's
// operator trusts that domain for Acme's tenant, with SPIRE's trust bundle.
// Acme's agent gets a JWT-SVID for spiffe://example.org/agents/buyer, whose
// audience is the mesh, makes its own key pair, and enrolls with the SVID
// (SPEC §4.14). It signs everything it sends with its own key from then on.
// The mesh records where its identity came from (identity_source, §9.7):
// another agent sees it in discovery and in describe, and the agent itself
// cannot change it.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MESH_API, admin, check, connect, enroll, run, say, sdk, sleep, tenant } from "../lib/mesh.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const compose = ["compose", "-f", join(HERE, "compose.yaml")];
const docker = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" }, stdio: ["ignore", "pipe", "pipe"], ...opts });
const spire = (...args) => docker([...compose, "exec", "-T", "spire-server", "/opt/spire/bin/spire-server", ...args]);

docker([...compose, "up", "-d"], { timeout: 180_000 });
try {
  // SPIRE takes a moment to make its keys.
  let svid = "";
  for (let i = 0; i < 30 && !svid; i++) {
    try { svid = spire("jwt", "mint", "-spiffeID", "spiffe://example.org/agents/buyer", "-audience", MESH_API).trim(); } catch { await sleep(1000); }
  }
  check(svid.split(".").length === 3, "SPIRE minted a JWT-SVID for spiffe://example.org/agents/buyer, for this mesh");
  const bundle = JSON.parse(spire("bundle", "show", "-format", "spiffe"));
  say(`SPIRE's trust bundle for example.org has ${bundle.keys.length} keys.`);

  // The operator: Acme's tenant trusts the trust domain example.org. A trust
  // domain belongs to one tenant on a mesh, and every SPIRE start here is a
  // new authority, so an earlier run's record is replaced.
  const acme = await tenant("acme-spiffe");
  const listed = await admin("GET", `/tenants/${acme}/trust`);
  for (const r of listed.json.trust ?? []) if (r.kind === "spiffe" && r.trust_domain === "example.org") await admin("DELETE", `/tenants/${acme}/trust/${r.id}`);
  const added = await admin("POST", `/tenants/${acme}/trust`, { kind: "spiffe", trust_domain: "example.org", bundle });
  check(added.status === 201, "Acme's tenant trusts the SPIFFE trust domain example.org (mesh-admin tenants trust add)");

  // The agent: its own key pair, and the SVID in place of an enrollment key.
  const me = sdk.createAgentIdentity();
  const creds = await sdk.exchangeOutsideProof(MESH_API, me.publicKey, { kind: "jwt-svid", token: svid });
  check(creds.identity_source?.kind === "spiffe" && creds.identity_source.workload_id === "spiffe://example.org/agents/buyer", "the agent enrolled with its JWT-SVID, and its identity source is spiffe://example.org/agents/buyer");
  const buyer = await connect({ id: me.publicKey, seed: me.seed, jwt: creds.jwt, credentialSeed: creds.seed, mesh: creds.mesh });
  buyer.onRequest("chat", (input) => ({ text: `Acme's buyer heard: ${input.text}` }));
  // Its manifest claims something else; the mesh's record is what others see.
  await buyer.register({
    name: `acme-buyer-${run}`, description: "Buys parts for Acme.", visibility: "public",
    offerings: [{ id: "chat", name: "Chat", description: "Talk to Acme's buyer." }],
    identity_source: { kind: "mesh", since: "2000-01-01T00:00:00Z" },
  });

  // Someone else: an agent enrolled the ordinary way, looking for agents whose
  // identity came from example.org.
  const other = await connect(await enroll(await tenant(`globex-${run}`), "globex seller"));
  const found = await other.discover({ identity_source: { kind: "spiffe", trust_domain: "example.org" }, agent_ids: [me.publicKey] });
  const card = found.agents.find((a) => a.id === me.publicKey);
  check(card?.identity_source?.kind === "spiffe", "discovery finds the buyer by its identity source, the mesh's record and not its own claim");
  const doc = await other.describe(me.publicKey);
  check(doc.identity_source?.trust_domain === "example.org" && !!doc.identity_source_attestation, "describe carries the identity source, with the mesh's signed attestation");
  const r = await other.request(me.publicKey, "chat", { text: "Do you need gaskets?" });
  check(/heard/.test(r.payload.output.text), "a message reaches it, signed with its own key as always");
  await buyer.close();
  await other.close();
  say("Done: SPIRE's JWT-SVID enrolled the agent, and the mesh says where its identity came from.");
} finally {
  try { docker([...compose, "down", "-v"], { timeout: 120_000 }); } catch { /* left for the operator */ }
}
