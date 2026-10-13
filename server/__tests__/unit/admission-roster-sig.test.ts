// The admission roster's signature (EXT-6 §3), domain-tagged: the signed
// bytes are ADMISSION_ROSTER_SIG_PREFIX + the canonical JSON of the document
// with `sig` excluded. Protocol 0.3 closed the 0.2 dual-accept window, so the
// verifier refuses the legacy untagged form the pre-0.3 adapter emitted; the
// adapter's signRoster flips to tagged in the same release, and stored
// rosters keep serving because only writes re-verify.
//
// The pinned vector comes from conformance/signature-tags.json (published
// test identities; the fixture is the authority).
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { KV } from "nats";
import { AdmissionStore, verifyRoster } from "../../src/admission/admission-store.js";
import { ADMISSION_ROSTER_SIG_PREFIX, canonicalJSON, nkeys, signTagged } from "../../src/sdk.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "conformance", "signature-tags.json"), "utf8"),
);

type Roster = Record<string, unknown>;

const owner = nkeys.createUser();
const ownerKey = owner.getPublicKey();

function rosterBody(): Roster {
  return {
    admission: "v1",
    owner_key: ownerKey,
    defaults: { contact: "allow", registered: "hold", anonymous: "block" },
    entries: [],
    updated_at: "2026-07-27T15:00:00.000Z",
  };
}

/** Sign the tagged form (what the adapter's signRoster emits once it flips). */
function signTaggedRoster(body: Roster): Roster {
  const sig = Buffer.from(
    signTagged(owner, ADMISSION_ROSTER_SIG_PREFIX, canonicalJSON(body)),
  ).toString("base64");
  return { ...body, sig };
}

/** Sign the legacy untagged form (what the adapter's signRoster emits today). */
function signLegacyRoster(body: Roster): Roster {
  const sig = Buffer.from(
    owner.sign(new TextEncoder().encode(canonicalJSON(body))),
  ).toString("base64");
  return { ...body, sig };
}

describe("verifyRoster — tagged signatures (EXT-6 §3)", () => {
  it("accepts a roster signed over ADMISSION_ROSTER_SIG_PREFIX + canonical JSON", () => {
    expect(ADMISSION_ROSTER_SIG_PREFIX).toBe("agentmesh-admission-roster-v1\n");
    expect(verifyRoster(signTaggedRoster(rosterBody()))).toBe(true);
  });

  it("refuses the legacy untagged form (the 0.2 dual-accept window closed at 0.3)", () => {
    expect(verifyRoster(signLegacyRoster(rosterBody()))).toBe(false);
  });

  it("rejects tampering under either form", () => {
    const tagged = signTaggedRoster(rosterBody());
    const legacy = signLegacyRoster(rosterBody());
    expect(verifyRoster({ ...tagged, defaults: { anonymous: "allow" } })).toBe(false);
    expect(verifyRoster({ ...legacy, defaults: { anonymous: "allow" } })).toBe(false);
  });

  it("rejects a roster claiming a different owner, and one with no signature", () => {
    const other = nkeys.createUser().getPublicKey();
    expect(verifyRoster({ ...signTaggedRoster(rosterBody()), owner_key: other })).toBe(false);
    expect(verifyRoster(rosterBody())).toBe(false);
  });

  it("verifies the pinned conformance vector and reproduces its canonical bytes", () => {
    const block = fixture.admission_roster;
    const { sig: _omit, ...body } = block.signed;
    expect(canonicalJSON(body)).toBe(block.canonical);
    expect(block.signed_bytes_prefix).toBe(ADMISSION_ROSTER_SIG_PREFIX);
    expect(verifyRoster(block.signed)).toBe(true);
  });
});

describe("AdmissionStore.put — the signature is the write authorization", () => {
  function makeStore() {
    const stored = new Map<string, string>();
    const kv = {
      put: vi.fn(async (k: string, v: string | Uint8Array) => {
        stored.set(k, String(v));
        return 1;
      }),
      get: vi.fn(async () => null),
    } as unknown as KV;
    return { store: new AdmissionStore(kv), stored };
  }

  it("stores a tagged-signed roster and refuses a tampered one", async () => {
    const { store, stored } = makeStore();
    const good = signTaggedRoster(rosterBody());
    expect(await store.put(ownerKey, good)).toBe(true);
    expect(stored.size).toBe(1);
    const bad = { ...signTaggedRoster(rosterBody()), entries: [{ subject: "UEVIL", stance: "allow" }] };
    expect(await store.put(ownerKey, bad)).toBe(false);
    expect(stored.size).toBe(1);
  });
});
