// Feeds (SPEC §6.6a, §14.1, §18.3), asserted against conformance/feeds.json.
//
// THE FIXTURE IS THE AUTHORITY. When something here fails, fix the SDK to
// agree with the fixture — never the fixture to agree with the code (the
// fixture changes only with a spec change alongside). Cases are executed by
// ITERATING the fixture: a row added to the JSON runs here without this file
// changing, and the coverage describe at the end fails the suite if any
// declared case went undriven. Payload agreement is compared through RFC 8785
// canonicalization, so it is byte-exact across the SDKs.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nkeys } from "nats.ws";
import { AgentMesh } from "../../src/mesh.js";
import { Subjects } from "../../src/internal/subjects.js";
import { createEnvelope } from "../../src/internal/envelope-builder.js";
import { signEnvelope, canonicalJSON } from "../../src/internal/identity.js";
import { encode, decode, decodeUnverified } from "../../src/internal/codec.js";
import type { ConnectionManager } from "../../src/internal/connection.js";
import type { Envelope } from "../../src/types/envelope.js";

const here = dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(
  readFileSync(join(here, "../../../conformance/feeds.json"), "utf8"),
) as {
  version: string;
  spec: string;
  subjects: {
    lookup_subject: string;
    build_cases: Array<{
      id: string;
      agent: string;
      topic: string;
      verdict: "accept" | "refuse";
      subject?: string;
    }>;
    parse_cases: Array<{
      id: string;
      subject: string;
      verdict: "accept" | "refuse";
      agent?: string;
      topic?: string;
    }>;
  };
  payload: {
    shape_cases: Array<{
      id: string;
      topic: string;
      kind: "state" | "stream";
      data: unknown;
      payload: unknown;
    }>;
    kind_cases: Array<{ id: string; kind: string; verdict: "accept" | "refuse" }>;
  };
  state_binding: {
    kv_key_cases: Array<{ id: string; agent: string; topic: string; key: string }>;
    lookup_request_cases: Array<{
      id: string;
      agent: string;
      topic: string;
      payload: unknown;
    }>;
  };
};

// ── the ledger ──────────────────────────────────────────────────────────────
// Every case this file drives records itself here; the final describe compares
// the ledger against a generic walk of the fixture, so a NEW section or row in
// the JSON is a failure rather than a blind spot (the inbound-protections
// pattern).

const executed = new Map<string, string>();
const unexecuted: { key: string; why: string }[] = [];
const caseKey = (section: string, id: string) => `${section}#${id}`;
const ran = (section: string, id: string, driver: string) => {
  executed.set(caseKey(section, id), driver);
};

/** Every `*_cases` / `cases` array in the fixture, found without being told
 *  where to look. */
function declaredCases(root: unknown): string[] {
  const out: string[] = [];
  const walk = (node: Record<string, unknown>, path: string) => {
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      if (Array.isArray(v)) {
        if (/cases$/.test(k)) {
          for (const el of v) out.push(caseKey(p, (el as { id: string }).id));
        }
      } else if (v && typeof v === "object") {
        walk(v as Record<string, unknown>, p);
      }
    }
  };
  walk(root as Record<string, unknown>, "");
  return out.sort();
}

// ── harness ─────────────────────────────────────────────────────────────────

/** The slice of ConnectionManager the feed paths touch: publish captured for
 *  the payload cases, request captured (and answered signed) for the lookup
 *  cases. */
function makeConn(respondWith?: (req: Envelope) => unknown) {
  const registryKp = nkeys.createUser();
  const published: Array<{
    subject: string;
    data: Uint8Array;
    headers?: Record<string, string>;
  }> = [];
  const requests: Array<{ subject: string; env: Envelope }> = [];
  const subs = new Map<string, (msg: unknown) => void>();
  const conn = {
    published,
    requests,
    subs,
    publish: (subject: string, data: Uint8Array, opts?: { headers?: Record<string, string> }) => {
      published.push({ subject, data, headers: opts?.headers });
    },
    request: async (subject: string, data: Uint8Array) => {
      const req = decodeUnverified(data);
      requests.push({ subject, env: req });
      return {
        data: encode(
          signEnvelope(
            createEnvelope({
              type: "respond",
              from: registryKp.getPublicKey(),
              to: req.from,
              in_reply_to: req.id,
              payload: respondWith ? respondWith(req) : { status: "ok" },
            }),
            registryKp,
          ),
        ),
      };
    },
    subscribe: (subject: string, cb: (msg: unknown) => void) => {
      subs.set(subject, cb);
      return { unsubscribe: () => subs.delete(subject), drain: async () => {} };
    },
    drain: async () => {},
    close: async () => {},
    get isClosed() {
      return false;
    },
  };
  return conn;
}
type Conn = ReturnType<typeof makeConn>;

const openAgents: AgentMesh[] = [];
afterEach(async () => {
  for (const a of openAgents.splice(0)) await a.close();
});

function agentOn(conn: Conn): AgentMesh {
  const agent = AgentMesh.withConnection(
    conn as unknown as ConnectionManager,
    nkeys.createUser(),
    nkeys.createUser(),
    { fenceInbound: false },
  );
  openAgents.push(agent);
  return agent;
}

// ── §6.6a subject grammar ───────────────────────────────────────────────────

describe("subject builder (fixture subjects.build_cases)", () => {
  it("has cases to assert", () => {
    expect(F.subjects.build_cases.length).toBeGreaterThan(0);
  });

  for (const c of F.subjects.build_cases) {
    if (c.verdict === "accept") {
      it(`${c.id}: builds the pinned subject for topic ${JSON.stringify(c.topic)}`, () => {
        expect(Subjects.feed(c.agent, c.topic)).toBe(c.subject);
        ran("subjects.build_cases", c.id, "Subjects.feed");
      });
    } else {
      it(`${c.id}: refuses topic ${JSON.stringify(c.topic).slice(0, 40)} at the builder`, () => {
        expect(() => Subjects.feed(c.agent, c.topic)).toThrow();
        // The publish path refuses the same way: a subject the builder would
        // not make is a subject publishFeed must not send.
        const conn = makeConn();
        const agent = agentOn(conn);
        expect(() => agent.publishFeed(c.topic, { n: 1 })).toThrow();
        expect(conn.published).toEqual([]);
        ran("subjects.build_cases", c.id, "Subjects.feed + publishFeed");
      });
    }
  }

  it('the "*" pattern belongs ONLY to the subscribe-side builder', () => {
    // feedPattern is the one place a wildcard topic is legitimate (§6.7);
    // feed() refusing it is pinned by s05 above.
    const owner = F.subjects.build_cases[0].agent;
    expect(Subjects.feedPattern(owner, "*")).toBe(`mesh.feed.${owner}.*`);
    expect(Subjects.feedPattern(owner, "status")).toBe(Subjects.feed(owner, "status"));
  });

  it("the lookup subject is the pinned three-token one", () => {
    expect(Subjects.FEED_GET).toBe(F.subjects.lookup_subject);
  });
});

describe("subject parser (fixture subjects.parse_cases)", () => {
  for (const c of F.subjects.parse_cases) {
    if (c.verdict === "accept") {
      it(`${c.id}: parses to its parts`, () => {
        expect(Subjects.parseFeedSubject(c.subject)).toEqual({
          agent: c.agent,
          topic: c.topic,
        });
        ran("subjects.parse_cases", c.id, "Subjects.parseFeedSubject");
      });
    } else {
      it(`${c.id}: ${JSON.stringify(c.subject).slice(0, 70)} is not a feed`, () => {
        expect(Subjects.parseFeedSubject(c.subject)).toBeNull();
        ran("subjects.parse_cases", c.id, "Subjects.parseFeedSubject");
      });
    }
  }
});

// ── §6.6a payload shape ─────────────────────────────────────────────────────

describe("feed emit payload (fixture payload.shape_cases)", () => {
  for (const c of F.payload.shape_cases) {
    it(`${c.id}: publishFeed sends exactly the pinned {topic, kind, data}`, () => {
      const conn = makeConn();
      const agent = agentOn(conn);
      agent.publishFeed(c.topic, c.data, { kind: c.kind });
      expect(conn.published).toHaveLength(1);
      const { subject, data, headers } = conn.published[0];
      expect(subject).toBe(Subjects.feed(agent.id, c.topic));
      const env = decode(data);
      expect(env.type).toBe("emit");
      expect(env.from).toBe(agent.id);
      // Byte-exact through RFC 8785, like every cross-SDK payload pin.
      expect(canonicalJSON(env.payload)).toBe(canonicalJSON(c.payload));
      // §18.8: the envelope id doubles as the Nats-Msg-Id, so MESH_FEED's
      // duplicate window can drop a duplicate publish.
      expect(headers).toEqual({ "Nats-Msg-Id": env.id });
      ran("payload.shape_cases", c.id, "publishFeed against a captured publish");
    });
  }
});

describe("feed kinds (fixture payload.kind_cases)", () => {
  for (const c of F.payload.kind_cases) {
    if (c.verdict === "accept") {
      it(`${c.id}: kind ${JSON.stringify(c.kind)} publishes`, () => {
        const conn = makeConn();
        const agent = agentOn(conn);
        agent.publishFeed("status", { n: 1 }, { kind: c.kind as "state" | "stream" });
        expect(conn.published).toHaveLength(1);
        const env = decode(conn.published[0].data);
        expect((env.payload as { kind?: string }).kind).toBe(c.kind);
        ran("payload.kind_cases", c.id, "publishFeed");
      });
    } else {
      it(`${c.id}: kind ${JSON.stringify(c.kind)} is refused — not a §6.6a kind`, () => {
        const conn = makeConn();
        const agent = agentOn(conn);
        expect(() =>
          agent.publishFeed("status", { n: 1 }, { kind: c.kind as "state" | "stream" }),
        ).toThrow();
        expect(() => agent.declareFeed("status", c.kind as "state" | "stream")).toThrow();
        expect(conn.published).toEqual([]);
        ran("payload.kind_cases", c.id, "publishFeed + declareFeed");
      });
    }
  }
});

// ── §18.3 state binding ─────────────────────────────────────────────────────

describe("state-feed KV key (fixture state_binding.kv_key_cases)", () => {
  for (const c of F.state_binding.kv_key_cases) {
    it(`${c.id}: the subject the SDK builds names exactly the platform's KV key`, () => {
      // The platform keys its current-value store {agent_id}.{topic} (§18.3):
      // precisely the feed subject minus the family prefix. Pinning that here
      // keeps the SDK's subject and the platform's key from ever drifting.
      expect(Subjects.feed(c.agent, c.topic)).toBe(`mesh.feed.${c.key}`);
      expect(Subjects.parseFeedSubject(`mesh.feed.${c.key}`)).toEqual({
        agent: c.agent,
        topic: c.topic,
      });
      ran("state_binding.kv_key_cases", c.id, "Subjects.feed / parseFeedSubject");
    });
  }
});

describe("current-value lookup (fixture state_binding.lookup_request_cases)", () => {
  for (const c of F.state_binding.lookup_request_cases) {
    it(`${c.id}: feedValue sends the pinned {agent, topic} to ${F.subjects.lookup_subject}`, async () => {
      const ownerKp = nkeys.createUser();
      const stored = signEnvelope(
        createEnvelope({
          type: "emit",
          from: ownerKp.getPublicKey(),
          payload: { topic: c.topic, kind: "state", data: { level: "ok" } },
        }),
        ownerKp,
      );
      const conn = makeConn(() => ({ found: true, envelope: stored }));
      const agent = agentOn(conn);
      const value = await agent.feedValue(c.agent, c.topic);
      expect(conn.requests).toHaveLength(1);
      expect(conn.requests[0].subject).toBe(F.subjects.lookup_subject);
      expect(canonicalJSON(conn.requests[0].env.payload)).toBe(canonicalJSON(c.payload));
      // {found: true, envelope} comes back as the envelope itself.
      expect(value?.id).toBe(stored.id);
      ran(
        "state_binding.lookup_request_cases",
        c.id,
        "feedValue against a captured serviceRequest",
      );
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// The fixture drives this suite, not the other way round
// ═══════════════════════════════════════════════════════════════════════════

describe("coverage of the fixture", () => {
  // Deliberately LAST in the file: vitest runs a file's tests in declaration
  // order, so by the time this runs the ledger is complete.
  it("every case in every *_cases array of the fixture was executed", () => {
    const declared = declaredCases(F);
    const missing = declared.filter(
      (k) => !executed.has(k) && !unexecuted.some((u) => u.key === k),
    );
    // A case added to the JSON — or a whole new section — lands here first.
    expect(missing).toEqual([]);
    // There is nothing in this fixture this suite cannot drive. If that ever
    // stops being true, the entry and its reason belong in `unexecuted`.
    expect(unexecuted).toEqual([]);
    expect([...executed.keys()].sort()).toEqual(declared);
  });
});
