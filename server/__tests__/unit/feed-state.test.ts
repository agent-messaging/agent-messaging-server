/**
 * State feeds, the platform side (shared/feed-state.ts + shared/feed-stream.ts).
 *
 * The properties worth pinning:
 *
 *  - a feed subject is EXACTLY `mesh.feed.{nkey}.{token}` — three-token
 *    subjects (`mesh.feed.get`), five-token subjects, bad owner keys and bad
 *    topics are all not feeds;
 *  - the writer records only what the owner published: a verified sender
 *    under somebody else's owner token is dropped (§6.6a's forgery case);
 *  - `history: 1` semantics ride the bucket — `current` returns the LAST
 *    publish, decoded, and null for a feed that never published;
 *  - forget purges one agent's feeds and nobody else's (closure by agent);
 *  - the stream config carries §18.3's row: interest retention, 24h, and the
 *    ≥2-minute duplicate-tracking window.
 */
import { describe, it, expect } from "vitest";
import { memKv, fakeJs } from "../helpers/fake-kv.js";
import { nkeys, createEnvelope, signEnvelope, encode } from "../../src/sdk.js";
import {
  FeedStateStore,
  parseFeedSubject,
  feedKvKey,
  feedWriteDecision,
  FEED_GET_SUBJECT,
  FEED_STATE_BUCKET,
} from "../../src/shared/feed-state.js";
import { feedStreamConfig, FEED_STREAM, FEED_SUBJECT } from "../../src/shared/feed-stream.js";

const ownerKp = nkeys.createUser();
const OWNER = ownerKp.getPublicKey();
const OTHER = nkeys.createUser().getPublicKey();

function signedEmit(kp: ReturnType<typeof nkeys.createUser>, data: unknown): Uint8Array {
  const env = createEnvelope({
    type: "emit",
    from: kp.getPublicKey(),
    payload: { topic: "status", kind: "state", data },
  });
  signEnvelope(env, kp as never);
  return encode(env);
}

function storeWithFakes() {
  const h = fakeJs();
  const mem = memKv(FEED_STATE_BUCKET, h);
  return { store: new FeedStateStore(h.js as never, mem.kv as never), mem };
}

describe("parseFeedSubject", () => {
  it("accepts exactly mesh.feed.{nkey}.{token}", () => {
    expect(parseFeedSubject(`mesh.feed.${OWNER}.status`)).toEqual({ agent: OWNER, topic: "status" });
  });

  it("rejects everything that is not a feed", () => {
    expect(parseFeedSubject(FEED_GET_SUBJECT)).toBeNull(); // three tokens
    expect(parseFeedSubject(`mesh.feed.${OWNER}.a.b`)).toBeNull(); // five tokens
    expect(parseFeedSubject(`mesh.event.${OWNER}.status`)).toBeNull(); // wrong family
    expect(parseFeedSubject(`mesh.feed.notankey.status`)).toBeNull(); // bad owner
    expect(parseFeedSubject(`mesh.feed.${OWNER}.bad topic`)).toBeNull(); // bad token
    expect(parseFeedSubject(`mesh.feed.${OWNER}.`)).toBeNull(); // empty token
  });
});

describe("feedWriteDecision (§6.6a: only the owner publishes)", () => {
  it("accepts the owner, names the parts", () => {
    expect(feedWriteDecision(`mesh.feed.${OWNER}.status`, OWNER)).toEqual({
      ok: true,
      agent: OWNER,
      topic: "status",
    });
  });

  it("drops a verified sender under somebody else's owner token", () => {
    const d = feedWriteDecision(`mesh.feed.${OWNER}.status`, OTHER);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("is not the owner");
  });

  it("drops non-feed subjects before looking at the sender", () => {
    expect(feedWriteDecision(FEED_GET_SUBJECT, OWNER).ok).toBe(false);
  });
});

describe("FeedStateStore", () => {
  it("current returns the LAST publish, decoded; null before any", async () => {
    const { store } = storeWithFakes();
    expect(await store.current(OWNER, "status")).toBeNull();
    await store.put(OWNER, "status", signedEmit(ownerKp, { v: 1 }));
    await store.put(OWNER, "status", signedEmit(ownerKp, { v: 2 }));
    const env = await store.current(OWNER, "status");
    expect(env).not.toBeNull();
    expect((env!.payload as { data: { v: number } }).data.v).toBe(2);
    expect(env!.from).toBe(OWNER);
  });

  it("keys are {agent}.{topic}, and topicsOf lists only that agent's", async () => {
    const { store, mem } = storeWithFakes();
    await store.put(OWNER, "status", signedEmit(ownerKp, {}));
    await store.put(OWNER, "rate", signedEmit(ownerKp, {}));
    await store.put(OTHER, "status", signedEmit(ownerKp, {}));
    expect([...mem.store.keys()]).toContain(feedKvKey(OWNER, "status"));
    expect((await store.topicsOf(OWNER)).sort()).toEqual(["rate", "status"]);
    expect(await store.topicsOf(OTHER)).toEqual(["status"]);
  });

  it("forget purges one agent's feeds and nobody else's", async () => {
    const { store } = storeWithFakes();
    await store.put(OWNER, "status", signedEmit(ownerKp, {}));
    await store.put(OTHER, "status", signedEmit(ownerKp, {}));
    await store.forget(OWNER);
    expect(await store.topicsOf(OWNER)).toEqual([]);
    expect(await store.topicsOf(OTHER)).toEqual(["status"]);
  });

  it("undecodable stored bytes read as no current value, not a throw", async () => {
    const { store, mem } = storeWithFakes();
    mem.writeRaw(feedKvKey(OWNER, "status"), "not an envelope");
    expect(await store.current(OWNER, "status")).toBeNull();
  });
});

describe("feedStreamConfig (§18.3's MESH_FEED row)", () => {
  it("carries the row exactly: interest, 24h, ≥2m dedup window", () => {
    const c = feedStreamConfig();
    expect(c.name).toBe(FEED_STREAM);
    expect(c.subjects).toEqual([FEED_SUBJECT]);
    expect(String(c.retention)).toBe("interest");
    expect(c.max_age).toBe(24 * 60 * 60 * 1_000_000_000);
    expect(c.duplicate_window).toBeGreaterThanOrEqual(2 * 60 * 1_000_000_000);
  });
});
