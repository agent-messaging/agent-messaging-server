// §8.8 `works_with` and §8.5.1's `credential` need.
//
// What is pinned here is the line the registry draws: it refuses shapes a
// renderer cannot show honestly, and it checks nothing about whether the claims
// are TRUE. A registrant may say it works with anybody — that is the point of
// the field, and verifying it needs machinery that does not exist.
import { describe, it, expect } from "vitest";
import { validateDeclarations, credentialNeedsOf } from "../../src/registry/declarations.js";
import type { Manifest } from "../../src/sdk.js";

const manifest = (over: Partial<Manifest> = {}): Manifest =>
  ({
    id: "UAAA",
    name: "DMV Helper",
    description: "Renews your registration.",
    version: "1.0.0",
    protocol_version: "0.2.0",
    endpoint: "mesh.agent.UAAA.inbox",
    node: { id: "UNODE", attestation: {} },
    capabilities: [],
    offerings: [],
    ...over,
  }) as unknown as Manifest;

describe("validateDeclarations — works_with (§8.8)", () => {
  it("accepts a manifest that declares nothing", () => {
    expect(validateDeclarations(manifest())).toBeNull();
  });

  it("accepts an integration claim about somebody else's service", () => {
    // The load-bearing case. Wrapping a service you did not build is
    // legitimate, and the registry does not get to have an opinion about it.
    const m = manifest({
      works_with: [
        { service: "Colorado DMV", domain: "dmv.colorado.gov", description: "Renewals and lookups." },
      ],
    });
    expect(validateDeclarations(m)).toBeNull();
  });

  it("checks nothing about whether the claim is true", () => {
    // An unverifiable domain is accepted, because nothing here verifies
    // domains and refusing would imply the ones we keep were checked.
    const m = manifest({ works_with: [{ service: "Definitely Not Real", domain: "example.invalid" }] });
    expect(validateDeclarations(m)).toBeNull();
  });

  it("refuses an entry with no service name", () => {
    expect(validateDeclarations(manifest({ works_with: [{ domain: "dmv.colorado.gov" } as never] })))
      .toMatch(/service is required|service must not be empty/);
    expect(validateDeclarations(manifest({ works_with: [{ service: "   " }] }))).toMatch(/must not be empty/);
  });

  it("refuses shapes a renderer cannot read", () => {
    expect(validateDeclarations(manifest({ works_with: "Colorado DMV" as never }))).toMatch(/must be an array/);
    expect(validateDeclarations(manifest({ works_with: ["Colorado DMV"] as never }))).toMatch(/must be an object/);
    expect(validateDeclarations(manifest({ works_with: [{ service: "A", domain: 7 as never }] }))).toMatch(
      /domain must be a string/,
    );
  });

  it("caps how many services one manifest may claim", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ service: `svc-${i}` }));
    expect(validateDeclarations(manifest({ works_with: many }))).toMatch(/at most 24/);
  });
});

describe("validateDeclarations — the credential need (§8.5.1)", () => {
  const withNeeds = (needs: unknown[]) =>
    manifest({
      offerings: [
        { id: "renew", name: "Renew", description: "Renews a registration.", needs } as never,
      ],
    });

  it("accepts a declared sign-in with its scope", () => {
    expect(
      validateDeclarations(
        withNeeds([{ credential: "Colorado DMV", scope: "read your registration record" }]),
      ),
    ).toBeNull();
  });

  it("leaves the other three kinds alone", () => {
    // §8.5.1 is explicit that needs must read well to a model rather than
    // validate well in a parser. Only the credential kind is checked.
    expect(
      validateDeclarations(withNeeds([{ resource: "git" }, { file: "application/pdf" }, { text: "brand guide" }])),
    ).toBeNull();
  });

  it("refuses a credential need that names no service", () => {
    // "This agent will ask you for credentials to (blank)" is not a
    // declaration, and an unreadable declaration is the same as none.
    expect(validateDeclarations(withNeeds([{ credential: "" }]))).toMatch(/must not be empty/);
    expect(validateDeclarations(withNeeds([{ credential: 12 }]))).toMatch(/must be a string/);
  });

  it("names the offering the bad need is in", () => {
    expect(validateDeclarations(withNeeds([{ credential: "" }]))).toContain("renew");
  });
});

describe("credentialNeedsOf", () => {
  const offerings = [
    { id: "a", needs: [{ credential: "Colorado DMV", scope: "lookups" }, { resource: "git" }] },
    { id: "b", needs: [{ credential: "Colorado DMV" }, { credential: "Salesforce", description: "your CRM" }] },
  ] as never;

  it("folds the sign-ins up and says each one once", () => {
    expect(credentialNeedsOf(offerings)).toEqual([
      { service: "Colorado DMV", scope: "lookups" },
      { service: "Salesforce", description: "your CRM" },
    ]);
  });

  it("is empty for an agent that asks for nothing", () => {
    expect(credentialNeedsOf([{ id: "a" } as never])).toEqual([]);
    expect(credentialNeedsOf(undefined)).toEqual([]);
  });
});

describe("validateDeclarations — the §8.9 sealing posture", () => {
  const KEY = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw";

  it("accepts a manifest that says nothing, which is what every older one says", () => {
    // The compatibility promise, at the registry: absent is legal forever, and
    // it means cleartext. Nothing here may ever start inferring a posture.
    expect(validateDeclarations(manifest())).toBeNull();
    expect(validateDeclarations(manifest({ encryption_key: KEY } as never))).toBeNull();
  });

  it("accepts both postures when there is a key to honour them with", () => {
    for (const sealing of ["required", "preferred"]) {
      expect(
        validateDeclarations(manifest({ encryption_key: KEY, sealing } as never)),
        sealing,
      ).toBeNull();
    }
  });

  it("refuses a posture with no encryption key", () => {
    // §8.9 makes this a MUST. Stored, it would advertise confidentiality that
    // fails on the first message, which is worse than advertising none.
    expect(validateDeclarations(manifest({ sealing: "required" } as never))).toMatch(
      /requires an encryption_key/,
    );
    expect(
      validateDeclarations(manifest({ sealing: "preferred", encryption_key: "  " } as never)),
    ).toMatch(/requires an encryption_key/);
  });

  it("refuses a value no reader can act on", () => {
    // Silence has a meaning. An unrecognised string must not get to share it.
    for (const bad of ["yes", "REQUIRED", "optional", 1, true, {}]) {
      expect(
        validateDeclarations(manifest({ encryption_key: KEY, sealing: bad } as never)),
        String(bad),
      ).toMatch(/sealing must be/);
    }
  });
});
