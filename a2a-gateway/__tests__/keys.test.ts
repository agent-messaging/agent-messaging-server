/**
 * Self-serve inbound API keys. The invariants:
 *
 *   - the raw key exists exactly once, in the mint reply — never in the file,
 *     never in a listing, never in any admin response;
 *   - a minted key admits its caller with an identity keyed by the RECORD,
 *     and a revoked key is a stranger on the very next request;
 *   - keys survive restarts (the file), and the env API_KEYS list keeps
 *     working unchanged beside them;
 *   - the admin key surface sits behind the same local-and-unproxied gate as
 *     the attachments one.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeyStore, redactKey } from "../src/inbound/keys.js";
import { Bridge } from "../src/bridge.js";
import { startInboundServer } from "../src/inbound/server.js";
import { fakeConnect } from "./helpers.js";

const open: Server[] = [];
afterEach(() => {
  while (open.length) {
    const s = open.pop()!;
    s.closeAllConnections?.();
    s.close();
  }
});

function tmpKeysPath(): string {
  return join(mkdtempSync(join(tmpdir(), "keys-store-")), "api-keys.json");
}

describe("the key store", () => {
  it("mints, verifies, persists across instances, and revokes on the next look", async () => {
    const path = tmpKeysPath();
    const a = new FileKeyStore(path);
    const { record, rawKey } = await a.mint({ accountId: "acct_1", label: "laptop" });
    expect(rawKey).toMatch(/^amk_[0-9a-f]{48}$/);
    expect(a.verify(rawKey)?.id).toBe(record.id);
    expect(a.verify("amk_" + "0".repeat(48))).toBeNull();

    // A second store over the same file sees the key.
    const b = new FileKeyStore(path);
    await b.load();
    expect(b.verify(rawKey)?.accountId).toBe("acct_1");

    // Revoke: verify fails immediately, the record remains as history.
    expect(await b.revoke(record.id)).toBe(true);
    expect(b.verify(rawKey)).toBeNull();
    expect((await b.get(record.id))?.revokedAt).toBeTruthy();
    expect(await b.revoke(record.id)).toBe(false); // idempotent-ish: says so

    // And the revocation persisted.
    const c = new FileKeyStore(path);
    await c.load();
    expect(c.verify(rawKey)).toBeNull();
  });

  it("stores no raw key: the file holds a digest, redaction drops even that", async () => {
    const path = tmpKeysPath();
    const store = new FileKeyStore(path);
    const { record, rawKey } = await store.mint({ accountId: "acct_1", label: "x" });
    const { readFileSync } = await import("node:fs");
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain(rawKey);
    expect(record.sha256).not.toBe(rawKey);
    const safe = redactKey(record) as Record<string, unknown>;
    expect(safe.sha256).toBeUndefined();
    expect(safe.prefix).toBe(rawKey.slice(0, 8));
  });
});

describe("admission with minted keys", () => {
  it("admits a minted key by record id, refuses it after revocation, and env keys still work", async () => {
    const keyStore = new FileKeyStore(tmpKeysPath());
    const { record, rawKey } = await keyStore.mint({ accountId: "acct_1", label: "x" });
    const bridge = new Bridge({
      meshUrl: "ws://127.0.0.1:1",
      publicBaseUrl: "http://127.0.0.1",
      port: 0,
      apiKeys: { "env-key-1": "operator" },
      keyStore,
    });

    expect(bridge.authorizeCaller("env-key-1", "198.51.100.4")).toEqual({ key: "key:env-key-1" });
    expect(bridge.authorizeCaller(rawKey, "198.51.100.4")).toEqual({ key: `acctkey:${record.id}` });
    expect(bridge.authorizeCaller("amk_" + "f".repeat(48), "198.51.100.4")).toMatchObject({ reason: "invalid_key" });

    await keyStore.revoke(record.id);
    expect(bridge.authorizeCaller(rawKey, "198.51.100.4")).toMatchObject({ reason: "invalid_key" });
  });

  it("a key store with live keys makes generated cards advertise bearer auth", async () => {
    const keyStore = new FileKeyStore(tmpKeysPath());
    const bridge = new Bridge({ meshUrl: "ws://x", publicBaseUrl: "http://x", port: 0, keyStore });
    expect(bridge.apiKeyRequired).toBe(false);
    await keyStore.mint({ accountId: "acct_1" });
    expect(bridge.apiKeyRequired).toBe(true);
  });
});

describe("the admin key surface", () => {
  async function setup() {
    const keyStore = new FileKeyStore(tmpKeysPath());
    const bridge = new Bridge({ meshUrl: "ws://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1", port: 0, keyStore });
    fakeConnect(bridge);
    const server = await startInboundServer(bridge);
    open.push(server);
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, keyStore };
  }

  it("mints once with the raw key, lists without it, revokes, filters by account", async () => {
    const { base } = await setup();
    const minted = await fetch(`${base}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "acct_1", label: "laptop" }),
    });
    expect(minted.status).toBe(201);
    const body = (await minted.json()) as { key: string; record: { id: string; sha256?: string } };
    expect(body.key).toMatch(/^amk_/);
    expect(body.record.sha256).toBeUndefined();

    await fetch(`${base}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "acct_2", label: "other" }),
    });

    const listed = (await (await fetch(`${base}/admin/keys?accountId=acct_1`)).json()) as {
      keys: Record<string, unknown>[];
    };
    expect(listed.keys).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(body.key);
    expect(JSON.stringify(listed)).not.toContain("sha256");

    const revoked = await fetch(`${base}/admin/keys/${body.record.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    expect((await fetch(`${base}/admin/keys/${body.record.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("sits behind the local-and-unproxied gate", async () => {
    const { base } = await setup();
    const resp = await fetch(`${base}/admin/keys`, { headers: { "X-Forwarded-For": "203.0.113.7" } });
    expect(resp.status).toBe(403);
  });
});
