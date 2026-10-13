/**
 * Subjects on the RabbitMQ binding (storage/rabbitmq/subjects.ts): the
 * mapping of §14.2's wildcards onto AMQP binding keys, the matching every
 * delivery is checked against, and the coverage test the broker's permission
 * check uses.
 */
import { describe, expect, it } from "vitest";
import {
  bindingKey,
  cameOnSubject,
  joinReply,
  patternCovers,
  patternOfBindingKey,
  patternsOverlap,
  splitReply,
  subjectMatches,
} from "../../src/storage/rabbitmq/subjects.js";
import { dedupKey } from "../../src/storage/rabbitmq/capture.js";
import { groupQueueName } from "../../src/storage/rabbitmq/messaging.js";
import { mailboxQueueArgs } from "../../src/storage/rabbitmq/storage.js";
import { amqpUrlFromEnv } from "../../src/storage/connect.js";

describe("RabbitMQ subjects", () => {
  it("maps `>` to `*.#` so it keeps needing one more word", () => {
    expect(bindingKey("mesh.event.>")).toBe("mesh.event.*.#");
    expect(bindingKey("mesh.feed.*.*")).toBe("mesh.feed.*.*");
    expect(bindingKey("mesh.agent.UX.inbox")).toBe("mesh.agent.UX.inbox");
    expect(bindingKey(">")).toBe("*.#");
    expect(() => bindingKey("a.>.b")).toThrow();
    expect(patternOfBindingKey("mesh.event.*.#")).toBe("mesh.event.>");
    expect(patternOfBindingKey("*.#")).toBe(">");
    expect(patternOfBindingKey("mesh.a.*")).toBe("mesh.a.*");
  });

  it("matches subjects as §14.2 says", () => {
    expect(subjectMatches("mesh.event.>", "mesh.event.a")).toBe(true);
    expect(subjectMatches("mesh.event.>", "mesh.event")).toBe(false);
    expect(subjectMatches("mesh.event.*", "mesh.event.a.b")).toBe(false);
    expect(subjectMatches("mesh.event.*", "mesh.event.a")).toBe(true);
    expect(subjectMatches("a.b", "a.b")).toBe(true);
    expect(subjectMatches("a.b", "a.b.c")).toBe(false);
  });

  it("decides whether one pattern covers another", () => {
    expect(patternCovers("mesh.agent.*.inbox", "mesh.agent.UX.inbox")).toBe(true);
    expect(patternCovers("mesh.task.*.update", "mesh.task.*.update")).toBe(true);
    expect(patternCovers("mesh.event.>", "mesh.event.a.*")).toBe(true);
    expect(patternCovers("mesh.event.>", "mesh.event.>")).toBe(true);
    expect(patternCovers("mesh.event.*", "mesh.event.>")).toBe(false);
    expect(patternCovers("mesh.agent.UX.inbox", "mesh.agent.*.inbox")).toBe(false);
    expect(patternCovers("_INBOX.>", "_INBOX.abc")).toBe(true);
    expect(patternsOverlap("mesh.admin.>", "mesh.>")).toBe(true);
    expect(patternsOverlap("mesh.admin.>", "mesh.event.>")).toBe(false);
    expect(patternsOverlap("mesh.*.x", "mesh.a.*")).toBe(true);
    expect(patternsOverlap("mesh.a", "mesh.a.b")).toBe(false);
  });

  it("keeps a direct reply-to name and its correlation id together", () => {
    const r = joinReply("amq.rabbitmq.reply-to.g2dkAAAA", "c-1")!;
    expect(splitReply(r)).toEqual({ replyTo: "amq.rabbitmq.reply-to.g2dkAAAA", correlationId: "c-1" });
    expect(splitReply("_INBOX.abc")).toEqual({ replyTo: "_INBOX.abc" });
    expect(joinReply(undefined, "x")).toBeUndefined();
  });

  it("deduplicates captured envelopes on (from, id)", () => {
    const te = new TextEncoder();
    expect(dedupKey(te.encode(JSON.stringify({ from: "UA", id: "1" })), undefined)).toBe("UA|1");
    expect(dedupKey(te.encode(JSON.stringify({ from: "UA", id: "1" })), "1")).toBe("UA|1");
    expect(dedupKey(te.encode(JSON.stringify({ from: "UA", id: "1" })), "ams-x")).toBe("ams-x");
    expect(dedupKey(te.encode("plain"), undefined)).toBeNull();
  });

  it("names queues and reads its settings by exact name", () => {
    expect(groupQueueName("svc.registry", "mesh.registry.discover")).toMatch(/^ams\.group\.svc\.registry\.[0-9a-f]{16}$/);
    expect(groupQueueName("q", "a")).not.toBe(groupQueueName("q", "b"));
    expect(mailboxQueueArgs({ maxAgeMs: 1000, maxBytes: 50 })).toEqual({
      "x-queue-type": "classic",
      "x-overflow": "drop-head",
      "x-message-ttl": 1000,
      "x-max-length-bytes": 50,
    });
    const url = amqpUrlFromEnv(
      { MESH_AMQP_URL: "amqp://rabbit:5672/mesh", MESH_AMQP_USER: "mesh-core", MESH_AMQP_PASSWORD_FILE: "/x" },
      () => "p@ss word\n",
    );
    expect(url).toBe("amqp://mesh-core:p%40ss%20word@rabbit:5672/mesh");
    expect(() => amqpUrlFromEnv({})).toThrow(/MESH_AMQP_URL/);
  });
});

describe("a delivery that came on a subject", () => {
  it("is one routed by the mesh exchange; one put into a queue by its name through the default exchange is not", () => {
    expect(cameOnSubject({ fields: { exchange: "mesh" } })).toBe(true);
    expect(cameOnSubject({ fields: { exchange: "" } })).toBe(false);
    expect(cameOnSubject({ fields: { exchange: "amq.topic" } })).toBe(false);
    expect(cameOnSubject({ fields: {} })).toBe(false);
    expect(cameOnSubject(null)).toBe(false);
  });
});
