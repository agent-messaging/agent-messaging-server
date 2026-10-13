/**
 * Bridged-caller attribution: it has to survive a restart.
 *
 * Honesty-list entry 33 said the mapping from an inbound A2A caller to its
 * hosted mesh identity lived in one `Map` and nowhere else, so a restart or a
 * pool eviction re-minted the identity and an audit row naming the old one
 * resolved to nobody. These tests pin the two halves of the fix: the record is
 * durable (and reproduces the SAME mesh id, via real nkeys derivation), and
 * every inbound envelope carries the §2.1 rule 2 / §8.3 marker.
 *
 * They also pin what must NOT be written down: the caller key, which for an
 * operator env-list caller literally embeds the raw API key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { FileCallerIdentityStore, callerKeyDigest, redactCaller, newCallerRecord } from "../src/inbound/identity-store.js";
import { FileKeyStore } from "../src/inbound/keys.js";
import { BRIDGE_EXTENSION_URI } from "../src/core/card.js";
import { fakeConnect, manifestFixture, sendMessageBody } from "./helpers.js";

let dir: string;
let storePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-callers-"));
  storePath = join(dir, "data", "caller-identities.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function bootBridge(overrides: Partial<ConstructorParameters<typeof Bridge>[0]> = {}) {
  const callerStore = new FileCallerIdentityStore(storePath);
  await callerStore.load();
  const bridge = new Bridge({
    meshUrl: "ws://127.0.0.1:1",
    publicBaseUrl: "http://localhost:8090",
    port: 8090,
    callerStore,
    ...overrides,
  });
  const mesh = fakeConnect(bridge);
  return { bridge, callerStore, mesh };
}

describe("a caller's identity survives a restart", () => {
  it("gives the same caller the same mesh id after the process is replaced", async () => {
    const first = await bootBridge({ apiKeys: { partnerkey: "partner" } });
    const before = await first.bridge.identityFor("key:partnerkey");
    expect(before.id).toMatch(/^U/); // a real nkeys user public key

    // A whole new Bridge, a whole new store instance: the only thing carried
    // across is the file, which is exactly what a restart carries across.
    const second = await bootBridge({ apiKeys: { partnerkey: "partner" } });
    const after = await second.bridge.identityFor("key:partnerkey");

    expect(after.id).toBe(before.id);
  });

  it("resolves an old identity's account after the restart that minted it is gone", async () => {
    const keys = new FileKeyStore(join(dir, "data", "api-keys.json"));
    const { record } = await keys.mint({ accountId: "acct_amber", label: "Amber's key" });

    const first = await bootBridge({ keyStore: keys });
    const agent = await first.bridge.identityFor(`acctkey:${record.id}`);
    const agentId = agent.id;
    expect(await first.bridge.accountForAgentId(agentId)).toBe("acct_amber");

    // The audit row is written. Time passes. The bridge restarts, and this
    // caller never comes back — nothing repopulates the live pool.
    const second = await bootBridge({ keyStore: keys });
    expect(second.bridge.accountForAgentId).toBeTypeOf("function");
    expect(await second.bridge.accountForAgentId(agentId)).toBe("acct_amber");
    expect(second.bridge.callerForAgentId(agentId)).toMatchObject({
      kind: "account",
      accountId: "acct_amber",
      keyRecordId: record.id,
      agentId,
    });
  });

  it("still recognises a restored identity as the bridge's own hosted caller", async () => {
    // The 402 gate's exemption (manager.ts admitPriced): a gateway caller has
    // already paid, and must not be charged again on the mesh-native path just
    // because the process that minted it exited.
    const first = await bootBridge({ apiKeys: { partnerkey: "partner" } });
    const agentId = (await first.bridge.identityFor("key:partnerkey")).id;

    const second = await bootBridge({ apiKeys: { partnerkey: "partner" } });
    expect(second.bridge.isHostedCaller(agentId)).toBe(true);
    expect(second.bridge.isHostedCaller("USOMEOTHERAGENT")).toBe(false);
  });

  it("keeps resolving an identity that was evicted from the live pool", async () => {
    const { bridge } = await bootBridge({ apiKeys: { a: "a" } });
    const agentId = (await bridge.identityFor("key:a")).id;

    // Eviction empties the live pool; the record is what remains.
    (bridge as unknown as { identities: Map<string, unknown> }).identities.clear();

    expect(bridge.isHostedCaller(agentId)).toBe(true);
    expect(bridge.callerForAgentId(agentId)?.agentId).toBe(agentId);
  });
});

describe("the durable record holds no credential", () => {
  it("never writes the caller key, only its digest", async () => {
    const { bridge } = await bootBridge({ apiKeys: { "s3cr3t-operator-key": "partner" } });
    await bridge.identityFor("key:s3cr3t-operator-key");

    const onDisk = await readFile(storePath, "utf8");
    expect(onDisk).not.toContain("s3cr3t-operator-key");
    expect(onDisk).toContain(callerKeyDigest("key:s3cr3t-operator-key"));
  });

  it("writes the file 0600 inside a 0700 directory", async () => {
    const { bridge } = await bootBridge({ apiKeys: { a: "a" } });
    await bridge.identityFor("key:a");

    // Windows does not carry POSIX mode bits; the assertion is meaningful only
    // where the deployment runs.
    if (process.platform === "win32") return;
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "data"))).mode & 0o777).toBe(0o700);
  });

  it("redacts the seed and the digest from everything that leaves the store", async () => {
    const rec = newCallerRecord({
      callerKey: "key:secret",
      agentId: "UAGENT",
      identitySeed: "SUAPRETENDSEED",
    });
    const out = redactCaller(rec) as Record<string, unknown>;
    expect(out.identitySeed).toBeUndefined();
    expect(out.callerKeyHash).toBeUndefined();
    expect(out.ref).toBe(rec.ref);
    expect(JSON.stringify(out)).not.toContain("SUAPRETENDSEED");
  });

  it("does not write anonymous callers down at all", async () => {
    const { bridge, callerStore } = await bootBridge({ allowAnonymous: true });
    await bridge.identityFor("ip:203.0.113.7");
    expect(callerStore.list()).toEqual([]);
  });
});

describe("the §2.1 rule 2 attribution marker", () => {
  it("registers a marker manifest for a named caller identity", async () => {
    const { bridge, mesh } = await bootBridge({ apiKeys: { a: "a" } });
    const agent = await bridge.identityFor("key:a");

    const reg = mesh.registrations.find((r) => r.agentId === agent.id);
    expect(reg).toBeDefined();
    expect(reg!.opts.extensions?.[0]?.uri).toBe(BRIDGE_EXTENSION_URI);
    expect(reg!.opts.meta?.a2a_bridge).toMatchObject({
      direction: "inbound",
      caller_kind: "operator",
      node: "UNODEFAKEFAKEFAKEFAKE",
    });
    // It answers nothing, so it must not turn up in open discovery as if it did.
    expect(reg!.opts.visibility).toBe("unlisted");
  });

  it("registers once per caller, not once per request", async () => {
    const { bridge, mesh } = await bootBridge({ apiKeys: { a: "a" } });
    await bridge.identityFor("key:a");
    await bridge.identityFor("key:a");
    await bridge.identityFor("key:a");
    expect(mesh.registrations).toHaveLength(1);
  });

  it("carries the same caller_ref on the wire as in the manifest", async () => {
    const { bridge, mesh } = await bootBridge({ apiKeys: { a: "a" } });
    await bridge.identityFor("key:a");

    const meta = bridge.attributionMeta("key:a");
    const registered = mesh.registrations[0].opts.meta?.a2a_bridge as { caller_ref: string };
    expect(meta?.a2a_bridge.caller_ref).toBe(registered.caller_ref);
    expect(meta?.a2a_bridge.direction).toBe("inbound");
  });

  it("keeps the caller_ref stable across a restart", async () => {
    const first = await bootBridge({ apiKeys: { a: "a" } });
    await first.bridge.identityFor("key:a");
    const before = first.bridge.attributionMeta("key:a")!.a2a_bridge.caller_ref;

    const second = await bootBridge({ apiKeys: { a: "a" } });
    await second.bridge.identityFor("key:a");
    expect(second.bridge.attributionMeta("key:a")!.a2a_bridge.caller_ref).toBe(before);
  });

  it("carries no account id — that resolves operator-side, not on the wire", async () => {
    const keys = new FileKeyStore(join(dir, "data", "api-keys.json"));
    const { record } = await keys.mint({ accountId: "acct_amber" });
    const { bridge, mesh } = await bootBridge({ keyStore: keys });
    await bridge.identityFor(`acctkey:${record.id}`);

    const wire = JSON.stringify(bridge.attributionMeta(`acctkey:${record.id}`));
    expect(wire).not.toContain("acct_amber");
    expect(JSON.stringify(mesh.registrations[0].opts.meta)).not.toContain("acct_amber");
    // ...but the operator lookup does resolve it.
    expect(bridge.listCallers("acct_amber")).toHaveLength(1);
  });

  it("marks anonymous callers on the wire but publishes no manifest for them", async () => {
    const { bridge, mesh } = await bootBridge({ allowAnonymous: true });
    await bridge.identityFor("ip:203.0.113.7");
    expect(bridge.attributionMeta("ip:203.0.113.7")?.a2a_bridge).toMatchObject({
      direction: "inbound",
      caller_kind: "anonymous",
    });
    expect(mesh.registrations).toEqual([]);
  });
});

describe("the marker reaches the wire, through the real HTTP surface", () => {
  const open: Server[] = [];
  afterEach(() => {
    while (open.length) {
      const s = open.pop()!;
      try {
        s.closeAllConnections?.();
      } catch {
        /* older node */
      }
      s.close();
    }
  });

  it("puts meta.a2a_bridge on the mesh request a stock A2A SendMessage causes", async () => {
    const callerStore = new FileCallerIdentityStore(storePath);
    await callerStore.load();
    const bridge = new Bridge({
      meshUrl: "ws://127.0.0.1:1",
      publicBaseUrl: "http://127.0.0.1",
      port: 0,
      apiKeys: { k1: "partner" },
      callerStore,
    });
    const mesh = fakeConnect(bridge, {
      discover: async () => ({ agents: [manifestFixture()], total: 1 }),
      getManifest: async (id: string) => {
        if (id !== "UAGENTPUBKEY") throw new Error("no such agent");
        return manifestFixture();
      },
    });
    const server = await startInboundServer(bridge);
    open.push(server);
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/agents/UAGENTPUBKEY/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer k1" },
      body: sendMessageBody(),
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();

    expect(mesh.requests).toHaveLength(1);
    const marker = mesh.requests[0].config?.meta?.a2a_bridge as Record<string, unknown>;
    expect(marker).toMatchObject({
      direction: "inbound",
      caller_kind: "operator",
      node: "UNODEFAKEFAKEFAKEFAKE",
      a2a_protocol_version: "1.0",
    });
    // The same handle the record carries — one caller, one name, everywhere.
    expect(marker.caller_ref).toBe(bridge.callerForAgentId(mesh.requests[0].from)?.ref);
    // And nothing in it names the credential the caller presented.
    expect(JSON.stringify(marker)).not.toContain("k1");
  });

  it("answers the operator's 'who was this?' on loopback, and nobody else's", async () => {
    const callerStore = new FileCallerIdentityStore(storePath);
    await callerStore.load();
    const keys = new FileKeyStore(join(dir, "data", "api-keys.json"));
    const { record, rawKey } = await keys.mint({ accountId: "acct_amber", label: "Amber" });

    const bridge = new Bridge({
      meshUrl: "ws://127.0.0.1:1",
      publicBaseUrl: "http://127.0.0.1",
      port: 0,
      keyStore: keys,
      callerStore,
    });
    fakeConnect(bridge, {
      discover: async () => ({ agents: [manifestFixture()], total: 1 }),
      getManifest: async () => manifestFixture(),
    });
    const server = await startInboundServer(bridge);
    open.push(server);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    await fetch(`${base}/agents/UAGENTPUBKEY/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: sendMessageBody(),
    }).then((r) => r.arrayBuffer());

    const listed = (await (await fetch(`${base}/admin/callers?accountId=acct_amber`)).json()) as {
      callers: Array<Record<string, unknown>>;
    };
    expect(listed.callers).toHaveLength(1);
    expect(listed.callers[0]).toMatchObject({ kind: "account", keyRecordId: record.id });
    // Redacted: no seed, and no digest of the key that was presented.
    expect(listed.callers[0].identitySeed).toBeUndefined();
    expect(listed.callers[0].callerKeyHash).toBeUndefined();

    // By agent id, which is what an audit row actually carries.
    const agentId = listed.callers[0].agentId as string;
    const one = (await (await fetch(`${base}/admin/callers/${agentId}`)).json()) as { accountId: string };
    expect(one.accountId).toBe("acct_amber");

    // The same request through the proxy is refused: /admin answers local and
    // unproxied callers only, and a forwarded header is proof of a proxy.
    const proxied = await fetch(`${base}/admin/callers`, { headers: { "X-Forwarded-For": "203.0.113.7" } });
    expect(proxied.status).toBe(403);
  });
});

describe("the store keeps its indexes honest", () => {
  it("resolves by ref as well as by agent id", async () => {
    const { bridge } = await bootBridge({ apiKeys: { a: "a" } });
    const agent = await bridge.identityFor("key:a");
    const ref = bridge.attributionMeta("key:a")!.a2a_bridge.caller_ref;
    expect(bridge.callerForRef(ref)?.agentId).toBe(agent.id);
  });

  it("keeps a superseded agent id resolvable when a caller is re-minted", async () => {
    const store = new FileCallerIdentityStore(storePath);
    await store.load();
    const first = newCallerRecord({
      callerKey: "acctkey:rec-1",
      accountId: "acct_amber",
      agentId: "UOLDIDENTITY",
      identitySeed: "SUAONE",
    });
    await store.put(first);
    await store.put({ ...first, agentId: "UNEWIDENTITY", identitySeed: "SUATWO" });

    // The forward lookup moves on; the audit trail's backward lookup does not.
    expect(store.byCallerKey("acctkey:rec-1")?.agentId).toBe("UNEWIDENTITY");
    expect(store.byAgentId("UOLDIDENTITY")?.accountId).toBe("acct_amber");
    expect(store.byAgentId("UNEWIDENTITY")?.accountId).toBe("acct_amber");
  });

  it("survives a reload with every index rebuilt", async () => {
    const store = new FileCallerIdentityStore(storePath);
    await store.load();
    const rec = newCallerRecord({
      callerKey: "acctkey:rec-1",
      accountId: "acct_amber",
      agentId: "UAGENT",
      identitySeed: "SUASEED",
    });
    await store.put(rec);

    const reloaded = new FileCallerIdentityStore(storePath);
    await reloaded.load();
    expect(reloaded.byAgentId("UAGENT")?.ref).toBe(rec.ref);
    expect(reloaded.byRef(rec.ref)?.agentId).toBe("UAGENT");
    expect(reloaded.byCallerKey("acctkey:rec-1")?.identitySeed).toBe("SUASEED");
    expect(reloaded.list("acct_amber")).toHaveLength(1);
    expect(reloaded.list("acct_someone_else")).toHaveLength(0);
  });
});
