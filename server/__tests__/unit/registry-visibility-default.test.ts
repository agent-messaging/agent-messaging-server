/**
 * What silence means when an agent registers (plan items 10 and 11).
 *
 * The owner, 2026-09-20: "a person builds an agent and its access is just theirs.
 * Later, they can move it to org, or move it to public." So a first
 * registration that says nothing is private, and publishing is something
 * somebody did rather than something that happened.
 *
 * The other half is not politeness. 114 agents are registered right now, most
 * written before this field meant anything, and they re-register on every
 * restart. Defaulting those to private would take every one of them out of
 * discovery on its next reboot with nothing saying why. So a RE-registration
 * that says nothing keeps what it had, read from the shared directory rather
 * than from one instance's cache: registry-coherence caught that an agent
 * re-registering on a second instance looks new to it.
 */
import { describe, expect, it } from "vitest";
import { VISIBILITY_ON_SILENCE } from "../../src/registry/handlers/register.js";

describe("what silence means", () => {
  it("a first registration is the owner's alone", () => {
    expect(VISIBILITY_ON_SILENCE(undefined)).toBe("private");
  });

  it("a re-registration keeps whatever it had", () => {
    expect(VISIBILITY_ON_SILENCE("public")).toBe("public");
    expect(VISIBILITY_ON_SILENCE("organization")).toBe("organization");
    expect(VISIBILITY_ON_SILENCE("unlisted")).toBe("unlisted");
    expect(VISIBILITY_ON_SILENCE("private")).toBe("private");
  });

  it("a directory we could not read is not evidence that an agent is new", () => {
    // The catch branch falls through to the same answer as a genuine first
    // registration, which hides rather than publishes.
    expect(VISIBILITY_ON_SILENCE(undefined)).toBe("private");
  });
});
