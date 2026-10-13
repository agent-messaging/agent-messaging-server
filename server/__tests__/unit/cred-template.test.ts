import { describe, it, expect } from "vitest";
import { durableAgentPermissions, assertNarrow, nodePermissions, assertNarrowNode, sandboxPermissions, assertNarrowSandbox, type CredPermissions } from "../../src/keychain/cred-template.js";
import { inboxStreamName } from "../../src/registry/inbox-buffer.js";
import { ArtifactSubjects } from "../../src/artifacts/artifacts-service.js";

// These cases exist because the bug they describe was invisible. `POST
// /v1/bootstrap` minted every durable agent credential with `{}` — an empty
// permissions block, which in NATS inherits the account's `default_permissions`
// rather than granting nothing. The credential worked perfectly; it just also
// worked on every other agent's inbox and on `$KV.mesh_sessions`, where
// signed-in humans' bearer tokens are the plaintext keys. Nothing failed, so
// nothing was noticed. The point of this file is that going back to `{}` — or
// widening a wildcard by accident — now breaks a test instead of a user.

const KEY = "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "UBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("durableAgentPermissions", () => {
  const p = durableAgentPermissions(KEY);

  it("subscribes the agent's OWN inbox, never the wildcard", () => {
    expect(p.sub.allow).toContain(`mesh.agent.${KEY}.inbox`);
    // The whole exposure in one assertion: this is what an empty block granted.
    expect(p.sub.allow).not.toContain("mesh.agent.*.inbox");
    expect(p.sub.allow.some((s) => s.includes(OTHER))).toBe(false);
  });

  it("still publishes to any agent's inbox, because that IS the mesh", () => {
    expect(p.pub.allow).toContain("mesh.agent.*.inbox");
  });

  it("does not reach the guarded inbox of an arbitrary agent", () => {
    // A single-token `*` cannot match the five-token guarded subject. If this
    // ever fails, the admission service's private relay became public.
    const pubbable = p.pub.allow.filter((s) => s.startsWith("mesh.agent."));
    for (const s of pubbable) {
      if (s.includes("*")) expect(s.split(".").length).toBe(4);
    }
  });

  it("denies the buckets and planes no agent may ever touch", () => {
    for (const s of ["$KV.>", "mesh.peer.>", "mesh.aclroom.>", "$SYS.>"]) {
      expect(p.pub.deny).toContain(s);
      expect(p.sub.deny).toContain(s);
    }
  });

  it("scopes every JetStream grant to the agent's own mailbox stream or its own feed consumer", () => {
    const stream = inboxStreamName(KEY);
    const js = p.pub.allow.filter((s) => s.startsWith("$JS."));
    expect(js.length).toBeGreaterThan(0);
    for (const s of js) {
      if (s === "$JS.API.INFO") continue;
      if (s.includes(`.MESH_FEED.`)) {
        // Named for this agent, token for token: never a `*` in the consumer's place.
        expect(s.split(".")).toContain(`mesh_feed_${KEY}`);
        continue;
      }
      expect(s).toContain(stream);
      expect(s).not.toContain(inboxStreamName(OTHER));
    }
    // A bare `$JS.API.>` is how a credential drains someone else's mail.
    expect(js).not.toContain("$JS.API.>");
  });

  it("grants exactly the JetStream calls the offline drain makes", () => {
    // Derived from sdk-typescript startOfflineDrain: streams.info,
    // consumers.info, consumers.add, consume, ack. If the drain grows a call,
    // this test should fail and the subject should be added deliberately.
    const stream = inboxStreamName(KEY);
    expect(p.pub.allow).toContain(`$JS.API.STREAM.INFO.${stream}`);
    expect(p.pub.allow).toContain(`$JS.API.CONSUMER.INFO.${stream}.*`);
    expect(p.pub.allow).toContain(`$JS.API.CONSUMER.MSG.NEXT.${stream}.*`);
    expect(p.pub.allow).toContain(`$JS.ACK.${stream}.>`);
    // Both consumer-create shapes: nats.js picks by server version.
    expect(p.pub.allow).toContain(`$JS.API.CONSUMER.CREATE.${stream}.*`);
    expect(p.pub.allow).toContain(`$JS.API.CONSUMER.DURABLE.CREATE.${stream}.*`);
  });

  it("grants exactly the JetStream calls a durable feed subscription makes, on its own consumer", () => {
    // §18.6 Feed Consumer: one consumer per agent on MESH_FEED, mesh_feed_<key>.
    // Derived from the SDKs' subscribeFeed(..., { durable }): consumers.info,
    // consumers.add/update (three API shapes), consume, ack.
    const c = `mesh_feed_${KEY}`;
    const feed = p.pub.allow.filter((s) => s.includes(".MESH_FEED."));
    expect(feed.sort()).toEqual([
      `$JS.ACK.MESH_FEED.${c}.>`,
      `$JS.API.CONSUMER.CREATE.MESH_FEED.${c}`,
      `$JS.API.CONSUMER.CREATE.MESH_FEED.${c}.>`,
      `$JS.API.CONSUMER.DURABLE.CREATE.MESH_FEED.${c}`,
      `$JS.API.CONSUMER.INFO.MESH_FEED.${c}`,
      `$JS.API.CONSUMER.MSG.NEXT.MESH_FEED.${c}`,
    ].sort());
    // No delete, no list, no stream info on the shared feed stream.
    expect(p.pub.allow.some((s) => s.includes("CONSUMER.DELETE") || s.includes("CONSUMER.LIST") || s === "$JS.API.STREAM.INFO.MESH_FEED")).toBe(false);
  });

  it("keeps the stream name in step with the registry that creates it", () => {
    // cred-template duplicates the naming rather than importing the JetStream
    // client. This is the assertion that makes the duplication safe.
    expect(p.pub.allow).toContain(`$JS.API.STREAM.INFO.MESH_INBOX_${KEY}`);
    expect(inboxStreamName(KEY)).toBe(`MESH_INBOX_${KEY}`);
  });

  it("two agents get credentials that are useless against each other", () => {
    const q = durableAgentPermissions(OTHER);
    for (const s of q.sub.allow) expect(s.includes(KEY)).toBe(false);
    for (const s of q.pub.allow) expect(s.includes(KEY)).toBe(false);
  });
});

describe("assertNarrow", () => {
  it("accepts the template it is meant to guard", () => {
    expect(() => assertNarrow(durableAgentPermissions(KEY), KEY)).not.toThrow();
  });

  it("REFUSES an empty permissions block — the original bug", () => {
    const empty: CredPermissions = { pub: { allow: [], deny: [] }, sub: { allow: [], deny: [] } };
    expect(() => assertNarrow(empty, KEY)).toThrow(/INHERITS account defaults/);
  });

  it("refuses a credential that could read another agent's inbox", () => {
    const p = durableAgentPermissions(KEY);
    p.sub.allow.push(`mesh.agent.${OTHER}.inbox`);
    expect(() => assertNarrow(p, KEY)).toThrow(/not scoped to this agent's key/);
  });

  it("refuses a wildcard inbox subscribe", () => {
    const p = durableAgentPermissions(KEY);
    p.sub.allow.push("mesh.agent.*.inbox");
    expect(() => assertNarrow(p, KEY)).toThrow(/not scoped to this agent's key/);
  });

  it("refuses JetStream access beyond the agent's own mailbox", () => {
    const p = durableAgentPermissions(KEY);
    p.pub.allow.push("$JS.API.>");
    expect(() => assertNarrow(p, KEY)).toThrow(/reaches JetStream outside/);
  });

  it("refuses a feed consumer that is not the agent's own, or a wildcard one", () => {
    for (const bad of [
      `$JS.API.CONSUMER.MSG.NEXT.MESH_FEED.mesh_feed_${OTHER}`,
      "$JS.API.CONSUMER.MSG.NEXT.MESH_FEED.*",
      `$JS.ACK.MESH_FEED.>`,
      `$JS.API.CONSUMER.DELETE.MESH_FEED.mesh_feed_${KEY}`,
    ]) {
      const p = durableAgentPermissions(KEY);
      p.pub.allow.push(bad);
      expect(() => assertNarrow(p, KEY)).toThrow(/reaches JetStream outside/);
    }
  });

  it("refuses a dropped deny, because deny is what holds when an allow widens", () => {
    const p = durableAgentPermissions(KEY);
    p.sub.deny = p.sub.deny.filter((s) => s !== "$KV.>");
    expect(() => assertNarrow(p, KEY)).toThrow(/sub\.deny is missing "\$KV\.>"/);
  });
});

// ─── Node credentials (SPEC §4.1 / §14.3) ────────────────────────────────────
//
// One host, one connection, N agents. §14.3: "a node's User JWT MUST define
// explicit publish and subscribe permissions covering the subjects of every
// agent it hosts." These pin the two properties that matter: every HOSTED
// agent's subjects are present (that was the gap — no mint path could produce
// this shape, so a multi-agent node violated on every hosted inbox), and no
// subject reaches an agent OUTSIDE the hosted set (the wildcard shortcut this
// template exists to forbid).

const NODE = "UCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

describe("nodePermissions", () => {
  const p = nodePermissions(NODE, [KEY, OTHER]);

  it("subscribes EVERY hosted agent's inbox, enumerated", () => {
    expect(p.sub.allow).toContain(`mesh.agent.${KEY}.inbox`);
    expect(p.sub.allow).toContain(`mesh.agent.${OTHER}.inbox`);
    expect(p.sub.allow).toContain(`mesh.agent.${KEY}.inbox.guarded`);
    expect(p.sub.allow).toContain(`mesh.agent.${OTHER}.inbox.guarded`);
  });

  it("never subscribes the inbox wildcard — enumerate, don't widen", () => {
    expect(p.sub.allow).not.toContain("mesh.agent.*.inbox");
    expect(p.sub.allow.some((s) => s.startsWith("mesh.agent.*") || s.startsWith("mesh.agent.>"))).toBe(false);
  });

  it("covers every hosted agent's mailbox drain and no one else's", () => {
    for (const k of [KEY, OTHER]) {
      expect(p.pub.allow).toContain(`$JS.API.STREAM.INFO.MESH_INBOX_${k}`);
      expect(p.pub.allow).toContain(`$JS.ACK.MESH_INBOX_${k}.>`);
    }
    const js = p.pub.allow.filter((s) => s.startsWith("$JS.") && s !== "$JS.API.INFO");
    for (const s of js) {
      expect(s.includes(KEY) || s.includes(OTHER)).toBe(true);
    }
  });

  it("covers every hosted agent's own feed consumer and no wildcard one", () => {
    for (const k of [KEY, OTHER]) {
      expect(p.pub.allow).toContain(`$JS.API.CONSUMER.MSG.NEXT.MESH_FEED.mesh_feed_${k}`);
      expect(p.pub.allow).toContain(`$JS.ACK.MESH_FEED.mesh_feed_${k}.>`);
    }
    expect(p.pub.allow.some((s) => s.includes("MESH_FEED.*"))).toBe(false);
    const bad = nodePermissions(NODE, [KEY]);
    bad.pub.allow.push(`$JS.API.CONSUMER.MSG.NEXT.MESH_FEED.mesh_feed_${OTHER}`);
    expect(() => assertNarrowNode(bad, [KEY])).toThrow(/reaches JetStream outside/);
  });

  it("still publishes to any agent's inbox, because that IS the mesh", () => {
    expect(p.pub.allow).toContain("mesh.agent.*.inbox");
  });

  it("denies the buckets and planes no credential may ever touch", () => {
    for (const never of ["$KV.>", "mesh.peer.>", "mesh.aclroom.>", "$SYS.>"]) {
      expect(p.pub.deny).toContain(never);
      expect(p.sub.deny).toContain(never);
    }
  });

  it("deduplicates the agent set", () => {
    const dup = nodePermissions(NODE, [KEY, KEY]);
    const inboxes = dup.sub.allow.filter((s) => s === `mesh.agent.${KEY}.inbox`);
    expect(inboxes.length).toBe(1);
  });

  it("passes its own narrowness assertion", () => {
    expect(() => assertNarrowNode(p, [KEY, OTHER])).not.toThrow();
  });
});

describe("assertNarrowNode", () => {
  it("REFUSES an empty agent set — a node credential must host someone", () => {
    const p = nodePermissions(NODE, [KEY]);
    expect(() => assertNarrowNode(p, [])).toThrow(/agent set is empty/);
  });

  it("refuses a subscribe outside the hosted set", () => {
    const p = nodePermissions(NODE, [KEY]);
    p.sub.allow.push(`mesh.agent.${OTHER}.inbox`);
    expect(() => assertNarrowNode(p, [KEY])).toThrow(/not scoped to a hosted agent/);
  });

  it("refuses a wildcard inbox subscribe", () => {
    const p = nodePermissions(NODE, [KEY]);
    p.sub.allow.push("mesh.agent.*.inbox");
    expect(() => assertNarrowNode(p, [KEY])).toThrow(/not scoped to a hosted agent/);
  });

  it("refuses JetStream access beyond the hosted agents' mailboxes", () => {
    const p = nodePermissions(NODE, [KEY]);
    p.pub.allow.push("$JS.API.>");
    expect(() => assertNarrowNode(p, [KEY])).toThrow(/reaches JetStream outside/);
  });

  it("refuses a dropped deny", () => {
    const p = nodePermissions(NODE, [KEY]);
    p.sub.deny = p.sub.deny.filter((s) => s !== "$KV.>");
    expect(() => assertNarrowNode(p, [KEY])).toThrow(/sub\.deny is missing "\$KV\.>"/);
  });
});

// ── the rooms control plane (EXT-5) ──────────────────────────────────────
//
// Neither template listed a single `mesh.rooms.*` subject until 2026-07-30. A
// NATS allow list is exhaustive, so rooms were unreachable for every credential
// the platform mints: verified against a live operator-mode broker as
// `Permissions Violation for Publish to "mesh.rooms.mine"` on both templates.
// Nothing caught it because `tools/local-acl-mesh.mjs` mints its test pool with
// `allow: [">"]` — that harness exercises the SERVICE, so a green rooms suite
// said nothing about what a real client is permitted to send.
//
// `credential` is the one that matters most: it is the mint the acl grade's
// broker enforcement rests on, so without it the grade cannot function at all.

/** Every verb in rooms-service.ts SUBJECTS. Kept as a literal list so adding a
 *  rooms subject without deciding whether clients may call it fails here. */
const ROOMS_VERBS = [
  "provision", "reclaim", "replay", "status", "attach", "fetch",
  "mine", "cursor", "usage", "admit", "credential", "expel",
] as const;

// The SAME trap, sprung a second time on 2026-08-03: the artifact store (§7.5)
// shipped with no subject in either template, so `mesh.artifacts.put` was
// refused for every credential the platform mints. Found by an end-to-end probe
// against the live mesh, not by any test here — the service logged a healthy
// startup the whole time, because a service answering on a subject nobody may
// publish to looks exactly like a service with no callers.
//
// The lesson is not "remember the list". It is that a new service subject is
// invisible until something asserts it, which is what the block below is for.

/** Every verb the artifact service answers on. Same discipline as ROOMS_VERBS:
 *  adding a subject without deciding whether clients may call it fails here. */
const ARTIFACT_VERBS = ["put", "fetch", "stat", "remove", "usage", "put.begin", "put.commit", "link", "keep"] as const;

describe.each([
  ["durableAgentPermissions", durableAgentPermissions(KEY)],
  ["nodePermissions", nodePermissions(NODE, [KEY, OTHER])],
])("%s: the artifact store", (_name, p: CredPermissions) => {
  it.each(ARTIFACT_VERBS)("can publish mesh.artifacts.%s", (verb) => {
    expect(p.pub.allow).toContain(`mesh.artifacts.${verb}`);
  });

  it("grants them by NAME, never as a wildcard", () => {
    expect(p.pub.allow).not.toContain("mesh.artifacts.>");
    expect(p.pub.allow).not.toContain("mesh.artifacts.*");
  });

  it("grants every subject the artifact service answers on", () => {
    // The list above is what a person decided; this is the join to what the
    // service actually subscribes, so a subject added there and forgotten
    // here fails now rather than in the field.
    for (const subject of Object.values(ArtifactSubjects)) expect(p.pub.allow).toContain(subject);
  });

  it("does not subscribe them — these are request-reply", () => {
    // A subscribe would let one client read other clients' artifact traffic,
    // including the bytes riding in a `put`.
    expect(p.sub.allow.some((s) => s.startsWith("mesh.artifacts"))).toBe(false);
  });
});

describe.each([
  ["durableAgentPermissions", durableAgentPermissions(KEY)],
  ["nodePermissions", nodePermissions(NODE, [KEY, OTHER])],
])("%s: the rooms control plane", (_name, p: CredPermissions) => {
  it.each(ROOMS_VERBS)("can publish mesh.rooms.%s", (verb) => {
    expect(p.pub.allow).toContain(`mesh.rooms.${verb}`);
  });

  it("grants the rooms verbs by NAME, never as a `mesh.rooms.>` wildcard", () => {
    // A wildcard would silently cover any verb the service grows later,
    // including ones no client should call.
    expect(p.pub.allow).not.toContain("mesh.rooms.>");
    expect(p.pub.allow).not.toContain("mesh.rooms.*");
  });

  it("still DENIES the acl traffic plane on the agent's own credential", () => {
    // An acl member reaches room traffic on the short-lived room-scoped
    // credential the service mints, over a second connection. That separation
    // is the grade; granting `mesh.aclroom.>` here would dissolve it.
    expect(p.pub.deny).toContain("mesh.aclroom.>");
    expect(p.sub.deny).toContain("mesh.aclroom.>");
    expect(p.sub.allow.some((s) => s.startsWith("mesh.aclroom"))).toBe(false);
  });

  it("does not subscribe the control plane — these are request-reply", () => {
    // Replies arrive on `_INBOX.>`. A subscribe here would let one client
    // read other clients' room requests.
    expect(p.sub.allow.some((s) => s.startsWith("mesh.rooms"))).toBe(false);
  });
});

// ── the sandbox (guest pool) template ────────────────────────────────────────
//
// The deployed shape as code. The hosted pool was re-minted to least privilege
// on 2026-07-25 by hand and the exact claims lived only inside those sixty
// JWTs; the public Compose bootstrap meanwhile minted its pool with `nsc add
// user` and no permissions at all — the empty-block bug, third site. This
// template is what lets a bootstrap mint narrow from birth, and this block
// pins it to the deployed shape entry for entry, so a subject cannot drift in
// or out without a deliberate edit here.

const POOL = "UDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

describe("sandboxPermissions", () => {
  const p = sandboxPermissions(POOL);

  it("publishes exactly the pool's enumerated subjects — no drift", () => {
    // Decoded from a live /v1/guest credential 2026-08-16, plus the eval-record
    // reads added with that pipeline. A subject added to the template without
    // being added here is a deliberate-decision failure, exactly like
    // ROOMS_VERBS above.
    expect([...p.pub.allow].sort()).toEqual([
      "mesh.activity.list",
      "mesh.admission.guard",
      "mesh.admission.unguard",
      "mesh.agent.*.inbox",
      `mesh.agent.${POOL}.outbox`,
      "mesh.catalog.get.*",
      "mesh.catalog.list",
      "mesh.event.>",
      `mesh.heartbeat.${POOL}`,
      "mesh.presence.get",
      "mesh.registry.descriptor.digest.*",
      "mesh.registry.descriptor.get.*",
      "mesh.registry.deregister",
      "mesh.registry.discover",
      "mesh.registry.eval.digest.*",
      "mesh.registry.eval.get.*",
      "mesh.registry.get.*",
      "mesh.registry.nodes.list",
      "mesh.registry.register",
      `mesh.registry.register.${POOL}`,
      "mesh.rooms.attach",
      "mesh.rooms.expel",
      "mesh.rooms.fetch",
      "mesh.rooms.provision",
      "mesh.rooms.reclaim",
      "mesh.rooms.replay",
      "mesh.rooms.status",
      "mesh.rooms.usage",
      "mesh.task.*.stream",
      "mesh.task.*.update",
      "mesh.task.get.*",
      "mesh.usage.list",
      "mesh.usage.summary",
      "mesh.usage.today",
    ].sort());
  });

  it("is live-only: no JetStream reach anywhere, and $JS.> denied outright", () => {
    for (const s of [...p.pub.allow, ...p.sub.allow]) expect(s.startsWith("$JS")).toBe(false);
    expect(p.pub.deny).toContain("$JS.>");
    expect(p.sub.deny).toContain("$JS.>");
    expect(p.pub.deny).toContain("$O.>");
  });

  it("closes the reply-forgery side: no _INBOX.> publish, bounded resp instead", () => {
    expect(p.pub.allow).not.toContain("_INBOX.>");
    expect(p.resp).toEqual({ max: 8, ttl: 300_000_000_000 });
  });

  it("keeps the acl enforcement verbs out of a stranger's hands, twice over", () => {
    // Not in the allow AND in the deny — deny wins if the allow ever widens.
    for (const verb of ["mesh.rooms.admit", "mesh.rooms.credential"]) {
      expect(p.pub.allow).not.toContain(verb);
      expect(p.pub.deny).toContain(verb);
      expect(p.sub.deny).toContain(verb);
    }
  });

  it("subscribes its OWN inbox only; two guests are useless against each other", () => {
    expect(p.sub.allow).toContain(`mesh.agent.${POOL}.inbox`);
    const q = sandboxPermissions(OTHER);
    for (const s of q.sub.allow) expect(s.includes(POOL)).toBe(false);
    for (const s of q.pub.allow) expect(s.includes(POOL)).toBe(false);
  });

  it("pins the two documented-open wide grants, so narrowing them is a decision", () => {
    // safety-considerations 7.7 (`_INBOX.>` subscribe) and 5.3 (`mesh.event.>`
    // subscribe): reproduced deliberately because the template mirrors what is
    // deployed. When either is narrowed, it happens in a rotation with its own
    // reasoning, and this test is updated in the same change.
    expect(p.sub.allow).toContain("_INBOX.>");
    expect(p.sub.allow).toContain("mesh.event.>");
  });
});

describe("assertNarrowSandbox", () => {
  it("accepts the template it is meant to guard", () => {
    expect(() => assertNarrowSandbox(sandboxPermissions(POOL), POOL)).not.toThrow();
  });

  it("REFUSES an empty permissions block — the original bug, third site", () => {
    const empty = { pub: { allow: [], deny: [] }, sub: { allow: [], deny: [] }, resp: { max: 8, ttl: 1 } };
    expect(() => assertNarrowSandbox(empty, POOL)).toThrow(/INHERITS account defaults/);
  });

  it("refuses ANY JetStream allow, even the handshake a durable agent gets", () => {
    const p = sandboxPermissions(POOL);
    p.pub.allow.push("$JS.API.INFO");
    expect(() => assertNarrowSandbox(p, POOL)).toThrow(/reaches JetStream/);
  });

  it("refuses a credential that could read another identity's inbox", () => {
    const p = sandboxPermissions(POOL);
    p.sub.allow.push(`mesh.agent.${OTHER}.inbox`);
    expect(() => assertNarrowSandbox(p, POOL)).toThrow(/not scoped to this identity's key/);
  });

  it("refuses the _INBOX.> publish grant by name", () => {
    const p = sandboxPermissions(POOL);
    p.pub.allow.push("_INBOX.>");
    expect(() => assertNarrowSandbox(p, POOL)).toThrow(/response-forgery/);
  });

  it("refuses a missing or widened resp bound", () => {
    const missing = { ...sandboxPermissions(POOL), resp: undefined } as never;
    expect(() => assertNarrowSandbox(missing, POOL)).toThrow(/resp bound is missing/);
    const wide = sandboxPermissions(POOL);
    wide.resp = { max: 64, ttl: 300_000_000_000 };
    expect(() => assertNarrowSandbox(wide, POOL)).toThrow(/wider than the pool's contract/);
  });

  it("refuses a dropped deny, including the sandbox-only ones", () => {
    const p = sandboxPermissions(POOL);
    p.sub.deny = p.sub.deny.filter((s) => s !== "$JS.>");
    expect(() => assertNarrowSandbox(p, POOL)).toThrow(/sub\.deny is missing "\$JS\.>"/);
  });
});
