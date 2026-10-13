/**
 * Rooms, on the credentials the platform actually mints.
 *
 * WHY THIS FILE EXISTS
 *
 * The rooms suite was green while rooms were completely unreachable in
 * production. `tools/local-acl-mesh.mjs` mints its test pool with
 * `pub/sub allow: [">"]` — deliberately, so a test exercises the SERVICE rather
 * than a credential — and the SDK's `rooms-live.test.ts` takes guest leases.
 * Neither shape is what a real client holds, and neither template in
 * `cred-template.ts` listed a single `mesh.rooms.*` subject. A NATS allow list is
 * exhaustive, so every durable agent and every Gateway node was answered
 * `Permissions Violation for Publish to "mesh.rooms.*"`: no open, no join, no
 * unread count, and no `mesh.rooms.credential` — which is the mint the acl
 * grade's broker enforcement rests on, so the grade could not function for
 * anybody.
 *
 * `__tests__/unit/cred-template.test.ts` now asserts the subjects are in the
 * templates. That is necessary and not sufficient: it cannot tell whether the
 * BROKER agrees, which is the layer that was refusing. So this spec mints from
 * the real template functions and drives a live operator-mode broker.
 *
 * ## Running it
 *
 *   node tools/local-acl-mesh.mjs /tmp/aclmesh
 *   docker run -d --name aclmesh -p 14222:4222 -p 18080:8080 \
 *     -v /tmp/aclmesh:/conf nats:2.10-alpine -c /conf/nats.conf
 *   NATS_URL=nats://127.0.0.1:14222 NATS_CREDS=/tmp/aclmesh/service.creds \
 *     ROOMS_MINT_SEED_FILE=/tmp/aclmesh/account.nk \
 *     ROOMS_MINT_ISSUER_ACCOUNT=<account from env.json> ROOMS_REQUIRE_OPERATOR=0 \
 *     npx tsx src/server-main.ts --service=rooms,registry
 *   ACL_MESH_DIR=/tmp/aclmesh npm run test:integration
 *
 * Skips itself when $ACL_MESH_DIR is unset, so the lane stays green without one.
 */

import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { connect, credsAuthenticator, nkeys, type NatsConnection } from "nats";
import { encodeUser } from "nats-jwt";
import { durableAgentPermissions, nodePermissions } from "../../src/keychain/cred-template.js";
import { createEnvelope, encode, signEnvelope } from "../../src/sdk.js";
import type { Envelope } from "../../src/sdk.js";
import { AgentMesh, createEncryptionIdentity, type Room } from "../../../sdk-typescript/src/index.js";

/** Output directory of `tools/local-acl-mesh.mjs`. */
const DIR = process.env.ACL_MESH_DIR;
const HAVE = !!DIR && existsSync(`${DIR}/env.json`);
const TCP = process.env.ACL_MESH_TCP ?? "nats://127.0.0.1:14222";
const WS = process.env.ACL_MESH_WS ?? "ws://127.0.0.1:18080";

const meshEnv = HAVE
  ? (JSON.parse(readFileSync(`${DIR}/env.json`, "utf8")) as { account: string; accountSeedFile: string })
  : null;
const acctKp = meshEnv
  ? nkeys.fromSeed(new TextEncoder().encode(readFileSync(meshEnv.accountSeedFile, "utf8").trim()))
  : null;

const conns: NatsConnection[] = [];
const meshes: AgentMesh[] = [];
const rooms: Room[] = [];

afterAll(async () => {
  // `stop`, not `close`: close is the creator's END-THE-ROOM and would post a
  // `close` frame from any room the test created. Teardown should say nothing.
  for (const r of rooms) { try { r.stop(); } catch { /* already detached */ } }
  for (const m of meshes) { try { await m.close(); } catch { /* closed */ } }
  for (const c of conns) { try { await c.close(); } catch { /* closed */ } }
});

const credsFile = (jwt: string, seed: string) =>
  new TextEncoder().encode(
    `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n` +
      `-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------\n`,
  );

/** Mint a user under the test account carrying exactly `perms`. */
async function mint(name: string, perms: object) {
  const kp = nkeys.createUser();
  const jwt = await encodeUser(name, kp, acctKp!, { ...perms, issuer_account: meshEnv!.account } as never);
  return { jwt, seed: new TextDecoder().decode(kp.getSeed()), kp, publicKey: kp.getPublicKey() };
}

/**
 * Publish one signed rooms request on a connection built from `cred`.
 *
 * A publish the credential is not allowed to make is refused ASYNCHRONOUSLY on
 * the connection's status channel; the request itself would just time out. So
 * watch both and report whichever arrives — otherwise a permissions violation
 * is indistinguishable from a service that is simply not running.
 */
async function askRooms(subject: string, cred: Awaited<ReturnType<typeof mint>>) {
  let violation = "";
  const nc = await connect({ servers: TCP, authenticator: credsAuthenticator(credsFile(cred.jwt, cred.seed)) });
  conns.push(nc);
  void (async () => {
    for await (const s of nc.status()) {
      if (String(s.data ?? s).includes("Permissions Violation")) violation = String(s.data ?? s);
    }
  })();

  const env = createEnvelope({ type: "request", from: cred.publicKey, to: "rooms", payload: {} } as never) as Envelope;
  signEnvelope(env, cred.kp as never);
  try {
    const msg = await nc.request(subject, encode(env), { timeout: 5000 });
    const reply = JSON.parse(new TextDecoder().decode(msg.data)) as Envelope;
    return { replied: true, violation, error: reply.error?.message ?? null };
  } catch (err) {
    return { replied: false, violation, error: err instanceof Error ? err.message : String(err) };
  }
}

describe.skipIf(!HAVE)("rooms reachability on template-minted credentials", () => {
  it("a DURABLE agent credential can reach the rooms control plane", async () => {
    const kp = nkeys.createUser();
    const cred = await mint("durable-rooms", durableAgentPermissions(kp.getPublicKey()));
    // Re-mint bound to the key the template was built for, as the real path does.
    const real = await (async () => {
      const jwt = await encodeUser("durable-rooms", kp, acctKp!, {
        ...durableAgentPermissions(kp.getPublicKey()), issuer_account: meshEnv!.account,
      } as never);
      return { jwt, seed: new TextDecoder().decode(kp.getSeed()), kp, publicKey: kp.getPublicKey() };
    })();
    void cred;

    const res = await askRooms("mesh.rooms.mine", real);
    expect(res.violation, "the durable template must permit the rooms control plane").toBe("");
    expect(res.replied, `no reply: ${res.error}`).toBe(true);
  });

  it("a NODE credential — the Gateway's shape — can reach the rooms control plane", async () => {
    const nkp = nkeys.createUser();
    const hosted = [nkeys.createUser().getPublicKey(), nkeys.createUser().getPublicKey()];
    const jwt = await encodeUser("node-rooms", nkp, acctKp!, {
      ...nodePermissions(nkp.getPublicKey(), hosted), issuer_account: meshEnv!.account,
    } as never);
    const real = { jwt, seed: new TextDecoder().decode(nkp.getSeed()), kp: nkp, publicKey: nkp.getPublicKey() };

    const res = await askRooms("mesh.rooms.mine", real);
    expect(res.violation, "the node template must permit the rooms control plane").toBe("");
    expect(res.replied, `no reply: ${res.error}`).toBe(true);
  });
});

/** An agent holding exactly what a signed-up agent gets: the durable template,
 *  bound to its own key, registered so its inbox is subscribed. */
async function templateAgent(name: string): Promise<AgentMesh> {
  const kp = nkeys.createUser();
  const jwt = await encodeUser(name, kp, acctKp!, {
    ...durableAgentPermissions(kp.getPublicKey()), issuer_account: meshEnv!.account,
  } as never);
  const mesh = await AgentMesh.connect(WS, { requireNamed: false,
    jwt,
    nkeySeed: new TextDecoder().decode(kp.getSeed()),
    encryptionSeed: createEncryptionIdentity().seed,
    name,
  });
  meshes.push(mesh);
  // Registering SUBSCRIBES the inbox, and an EXT-5 invite is an ordinary
  // pairwise request to it — without this the inviter gets "no responders".
  await mesh.register({ name, capabilities: [], offerings: [] });
  return mesh;
}

describe.skipIf(!HAVE)("the acl grade, end to end, on real credentials", () => {
  it("opens, admits, joins, carries a message, and refuses a stranger", async () => {
    const alice = await templateAgent("acl-e2e-creator");
    const bob = await templateAgent("acl-e2e-member");
    const eve = await templateAgent("acl-e2e-stranger");

    let invited = false;
    bob.onRequest("rooms.invite", async () => { invited = true; return { ok: true }; });
    await new Promise((r) => setTimeout(r, 500));

    const room = await alice.openRoom({ acl: true, durable: true, name: "acl-e2e" });
    rooms.push(room);
    expect(room.descriptor.privacy).toBe("acl");

    await room.invite(bob.agentId);
    expect(invited, "the invite must reach the member's rooms.invite offering").toBe(true);

    // The load-bearing step: mesh.rooms.credential, then a SECOND connection on
    // the room-scoped credential to the broker-enforced namespace.
    const bobRoom = await bob.joinRoom(room.descriptor);
    rooms.push(bobRoom);

    const heard: string[] = [];
    bobRoom.onMessage((m) => { if (m.type === "say") heard.push(m.body as string); });
    await new Promise((r) => setTimeout(r, 800));
    room.say("hello across the broker-enforced namespace");

    const t0 = Date.now();
    while (!heard.length && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 150));
    expect(heard).toContain("hello across the broker-enforced namespace");

    // Eve holds the descriptor and is still refused. That is the grade: the
    // broker enforces membership, not descriptor possession.
    await expect(eve.joinRoom(room.descriptor)).rejects.toThrow(/not admitted/i);
  });
});
