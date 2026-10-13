// The room playbook (EXT-5 §8.5).
//
// Two properties carry the design and both are testable without a mesh: a
// descriptor written before this field existed must still verify byte for
// byte, and a pattern this SDK has never heard of must survive the round
// trip rather than being dropped from a document somebody signed.

import { describe, it, expect } from "vitest";
import {
  Room,
  signDescriptor,
  verifyDescriptor,
  normalizePlaybook,
  type RoomDescriptor,
  type RoomHost,
  type RoomMessage,
} from "../../src/rooms.js";
import { nkeys } from "nats.ws";
import type { Subscription } from "nats.ws";
import type { Envelope } from "../../src/types/envelope.js";
import { decode } from "../../src/internal/codec.js";

const base = (): Omit<RoomDescriptor, "sig"> => ({
  rooms: "v1",
  room_id: "abcdefghijklmnopqr",
  name: "review",
  channels: ["main"],
  record: "ephemeral",
  policy: {},
  privacy: "capability",
  creator: "",
  created_at: "2026-08-24T00:00:00.000Z",
});

describe("a declared playbook", () => {
  it("is covered by the creator's signature, and a tampered pattern fails", () => {
    const kp = nkeys.createUser();
    const d = signDescriptor(
      { ...base(), creator: kp.getPublicKey(), playbook: { pattern: "critique-circle", standard: "https://agentcollab.dev" } },
      kp,
    );
    expect(verifyDescriptor(d)).toBe(true);

    const tampered = { ...d, playbook: { ...d.playbook!, pattern: "relay" } };
    expect(verifyDescriptor(tampered)).toBe(false);
  });

  it("leaves a descriptor without one signing exactly as it did before the field existed", () => {
    const kp = nkeys.createUser();
    const without = signDescriptor({ ...base(), creator: kp.getPublicKey() }, kp);
    const explicitlyAbsent = signDescriptor(
      { ...base(), creator: kp.getPublicKey(), playbook: undefined },
      kp,
    );
    // Same bytes signed, so the same signature: absence is absence, not an
    // empty member that would fork every pre-existing room's canonical form.
    expect(explicitlyAbsent.sig).toBe(without.sig);
    expect(verifyDescriptor(without)).toBe(true);
    expect("playbook" in JSON.parse(JSON.stringify(without))).toBe(false);
  });

  it("carries a pattern this SDK has never heard of", () => {
    const kp = nkeys.createUser();
    const d = signDescriptor(
      { ...base(), creator: kp.getPublicKey(), playbook: { pattern: "some-future-pattern", standard: "https://example.org/patterns" } },
      kp,
    );
    expect(verifyDescriptor(d)).toBe(true);
    expect(d.playbook?.pattern).toBe("some-future-pattern");
    expect(d.playbook?.standard).toBe("https://example.org/patterns");
  });
});

describe("normalizePlaybook", () => {
  it("defaults the standard, trims, and bounds what gets signed", () => {
    const out = normalizePlaybook({ pattern: "  relay  ", note: "x".repeat(400), roles: { a: " facilitator " } })!;
    expect(out.pattern).toBe("relay");
    expect(out.standard).toBe("https://agentcollab.dev");
    expect(out.note!.length).toBe(280);
    expect(out.roles).toEqual({ a: "facilitator" });
  });

  it("says nothing rather than saying an empty thing", () => {
    expect(normalizePlaybook(undefined)).toBeUndefined();
    expect(normalizePlaybook({ pattern: "   " })).toBeUndefined();
  });

  it("opens where the agenda begins when only an agenda was given", () => {
    const out = normalizePlaybook({ agenda: ["roll-call", "critique-circle"] } as never)!;
    expect(out.pattern).toBe("roll-call");
    expect(out.agenda).toEqual(["roll-call", "critique-circle"]);
  });

  it("puts the opening pattern first on the agenda, once", () => {
    const out = normalizePlaybook({
      pattern: "critique-circle",
      agenda: ["roll-call", "critique-circle", "spec-then-build"],
    })!;
    expect(out.agenda).toEqual(["critique-circle", "roll-call", "spec-then-build"]);
  });

  it("keeps every agenda entry once, because the phase is found in it by first position", () => {
    // A repeated entry would make "what remains" walk backwards the second
    // time the room reached it. Revisiting a pattern is what phase calls are
    // for; the plan is a set in order.
    const out = normalizePlaybook({
      pattern: "sketch",
      agenda: ["sketch", "critique-circle", "revise", "critique-circle"],
    })!;
    expect(out.agenda).toEqual(["sketch", "critique-circle", "revise"]);
  });

  it("carries the plan's WHAT: goal, inputs with owners, promised outputs", () => {
    const out = normalizePlaybook({
      pattern: "critique-circle",
      goal: "  a drafted HR handbook  ",
      inputs: [{ name: " current policies ", from: "UHRR" }, { name: "style guide" }, { name: "  " }],
      outputs: [" handbook draft ", "handbook draft", ""],
    })!;
    expect(out.goal).toBe("a drafted HR handbook");
    expect(out.inputs).toEqual([{ name: "current policies", from: "UHRR" }, { name: "style guide" }]);
    expect(out.outputs).toEqual(["handbook draft"]);
  });

  it("a goal alone is a plan; deliverables alone are not", () => {
    // A room may know what done looks like before it knows how it works —
    // the shape then emerges in the room, usually as the facilitator's
    // proposal. Outputs with no goal and no shape stay nothing.
    const goalOnly = normalizePlaybook({ goal: "a drafted HR handbook" })!;
    expect(goalOnly.pattern).toBeUndefined();
    expect(goalOnly.goal).toBe("a drafted HR handbook");
    expect(normalizePlaybook({ outputs: ["handbook draft"] })).toBeUndefined();
  });

  it("reads a facilitator written into roles, so there is one answer to who may call a phase", () => {
    const out = normalizePlaybook({ pattern: "relay", roles: { UAAA: "facilitator", UBBB: "critic" } })!;
    expect(out.facilitator).toBe("UAAA");
    // An explicit facilitator wins over one inferred from roles.
    const explicit = normalizePlaybook({ pattern: "relay", facilitator: "UCCC", roles: { UAAA: "facilitator" } })!;
    expect(explicit.facilitator).toBe("UCCC");
  });
});

// ── phases: where the room actually is (EXT-5 §8.5) ────────────────────────

/** An in-memory bus, small enough to live here: every host publishes into it
 *  and every matching subscription hears it, exactly as the transport does. */
function makeBus() {
  const subs: Array<{ pattern: string; cb: (env: Envelope) => void }> = [];
  const matches = (pattern: string, subject: string) => {
    const p = pattern.split(".");
    const s = subject.split(".");
    return p.length === s.length && p.every((part, i) => part === "*" || part === s[i]);
  };
  const makeHost = (kp = nkeys.createUser()): RoomHost => ({
    agentId: kp.getPublicKey(),
    keyPair: kp,
    publish(subject, data) {
      for (const s of [...subs]) {
        if (!matches(s.pattern, subject)) continue;
        try {
          s.cb(decode(data));
        } catch { /* dropped, as on the wire */ }
      }
    },
    subscribe(subject, onEnvelope) {
      const entry = { pattern: subject, cb: onEnvelope };
      subs.push(entry);
      return {
        unsubscribe() {
          const i = subs.indexOf(entry);
          if (i >= 0) subs.splice(i, 1);
        },
      } as unknown as Subscription;
    },
    request: async () => ({}),
    serviceRequest: async () => ({}),
    getEncryptionKey: async () => null,
  });
  return { makeHost };
}

describe("the phase", () => {
  it("starts at the pattern the descriptor opened with, called by nobody", () => {
    const { makeHost } = makeBus();
    const host = makeHost();
    const room = Room.open(host, {
      name: "review",
      playbook: normalizePlaybook({ pattern: "roll-call", agenda: ["roll-call", "critique-circle"] }),
    });
    expect(room.phase?.pattern).toBe("roll-call");
    // `by: null` is the difference between "the room opened here" and
    // "somebody moved it here", which a surface needs to tell apart.
    expect(room.phase?.by).toBeNull();
    expect(room.remainingAgenda).toEqual(["critique-circle"]);
  });

  it("bounds the remaining agenda of a descriptor somebody else signed", () => {
    // Our own writer normalizes the agenda, but a joined descriptor is signed
    // and arrives verbatim — the ceiling has to hold on the way out.
    const { makeHost } = makeBus();
    const member = makeHost();
    const kp = nkeys.createUser();
    const d = signDescriptor(
      {
        ...base(),
        creator: kp.getPublicKey(),
        playbook: {
          pattern: "p0",
          agenda: ["p0", ...Array.from({ length: 30 }, (_, i) => `p${i + 1}`)],
          standard: "https://agentcollab.dev",
        },
      },
      kp,
    );
    const joined = Room.join(member, d);
    expect(joined.remainingAgenda.length).toBe(12);
    expect(joined.remainingAgenda[0]).toBe("p1");
  });

  it("is null in a room that declared no playbook, which is not the same as having no rules", () => {
    const { makeHost } = makeBus();
    const room = Room.open(makeHost(), { name: "quiet" });
    expect(room.phase).toBeNull();
    expect(room.facilitator).toBeNull();
    expect(room.brief()).toBe("");
  });

  it("moves when the facilitator calls one, for the caller and for every member", () => {
    const { makeHost } = makeBus();
    const creator = makeHost();
    const member = makeHost();
    const room = Room.open(creator, {
      name: "review",
      playbook: normalizePlaybook({ pattern: "roll-call", agenda: ["roll-call", "critique-circle"] }),
    });
    const joined = Room.join(member, room.descriptor);

    room.callPhase("critique-circle", { note: "two rounds" });

    expect(room.phase).toMatchObject({ pattern: "critique-circle", note: "two rounds", by: creator.agentId });
    expect(joined.phase).toMatchObject({ pattern: "critique-circle", by: creator.agentId });
    expect(joined.remainingAgenda).toEqual([]);
  });

  it("does not move on a phase from anyone else, and still delivers it", () => {
    const { makeHost } = makeBus();
    const creator = makeHost();
    const other = makeHost();
    const room = Room.open(creator, {
      name: "review",
      playbook: normalizePlaybook({ pattern: "roll-call" }),
    });
    const heard: RoomMessage[] = [];
    room.onMessage((m) => heard.push(m));

    const gatecrasher = Room.join(other, room.descriptor);
    // Bypasses callPhase's own guard on purpose: the point of the test is what
    // a RECEIVER does with a phase it had no reason to trust.
    (gatecrasher as unknown as { post: (m: RoomMessage) => void }).post({
      type: "phase",
      pattern: "bake-off",
    });

    // Carried, because it is a signed statement somebody made...
    expect(heard.some((m) => m.type === "phase" && m.pattern === "bake-off")).toBe(true);
    // ...and ignored, because the room agreed whose calls count.
    expect(room.phase?.pattern).toBe("roll-call");
  });

  it("refuses a phase call from a member who does not facilitate", () => {
    const { makeHost } = makeBus();
    const creator = makeHost();
    const member = makeHost();
    const room = Room.open(creator, { name: "review", playbook: normalizePlaybook({ pattern: "roll-call" }) });
    const joined = Room.join(member, room.descriptor);
    expect(() => joined.callPhase("relay")).toThrow(/facilitator/);
    // And in a room with no playbook there is no phase to move at all.
    const plain = Room.open(makeHost(), { name: "quiet" });
    expect(() => plain.callPhase("relay")).toThrow(/no playbook/);
  });

  it("hands the facilitator's job to a declared member rather than the creator", () => {
    const { makeHost } = makeBus();
    const creator = makeHost();
    const chair = makeHost();
    const room = Room.open(creator, {
      name: "review",
      playbook: normalizePlaybook({ pattern: "roll-call", facilitator: chair.agentId }),
    });
    const chaired = Room.join(chair, room.descriptor);
    expect(room.mayCallPhase).toBe(false);
    expect(chaired.mayCallPhase).toBe(true);
    expect(() => room.callPhase("relay")).toThrow(/facilitator/);

    chaired.callPhase("relay");
    expect(room.phase?.pattern).toBe("relay");
  });

  it("a goal-only room has no phase until one is called, and still briefs", () => {
    const { makeHost } = makeBus();
    const creator = makeHost();
    const room = Room.open(creator, {
      name: "handbook",
      playbook: normalizePlaybook({ goal: "a drafted HR handbook", outputs: ["handbook draft"] }),
    });
    // No opening pattern: the room knows WHAT, not yet HOW.
    expect(room.phase).toBeNull();
    const brief = room.brief();
    expect(brief).toContain("exists to produce: a drafted HR handbook");
    expect(brief).toContain("It promises: handbook draft");
    expect(brief).toMatch(/has not opened in a pattern yet/);
    // The first phase call gives it a shape.
    room.callPhase("briefing");
    expect(room.phase?.pattern).toBe("briefing");
  });

  it("briefs an agent on where the room is, and says nothing enforces it", () => {
    const { makeHost } = makeBus();
    const creator = makeHost();
    const critic = makeHost();
    const room = Room.open(creator, {
      name: "the launch post",
      playbook: normalizePlaybook({
        pattern: "roll-call",
        agenda: ["roll-call", "critique-circle"],
        roles: { [critic.agentId]: "critic" },
        note: "two rounds, then the author decides",
      }),
    });
    const joined = Room.join(critic, room.descriptor);

    const brief = joined.brief();
    expect(brief).toContain("roll-call");
    expect(brief).toContain("agentcollab.dev");
    expect(brief).toContain("critique-circle"); // what is still planned
    expect(brief).toContain("Your role in this room is critic");
    expect(brief).toMatch(/Nothing on the mesh enforces it/);
    // The facilitator is told it facilitates; nobody else is.
    expect(room.brief()).toContain("You facilitate");
    expect(brief).not.toContain("You facilitate");
  });
});
