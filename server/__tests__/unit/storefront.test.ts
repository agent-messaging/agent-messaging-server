// §8.7 storefront materialization.
//
// The rules pinned here are the ones that make the derivation trustworthy: a
// registrant cannot write these fields, a stale advertisement cannot invent a
// offering, and an unchanged manifest must come back as the SAME OBJECT (the
// manifest watch compares identity, so a fresh object every pass would report
// every read as a change).
import { describe, it, expect } from "vitest";
import {
  readableCompliance,
  readableDataUse,
  readablePublicAccess,
  readablePublicUis,
  readableReporting,
  withReadableCompliance,
  withReadableDataUse,
  withReadableReporting,
  withStorefront,
  type PublicUiEntry,
} from "../../src/registry/storefront.js";
import type { AgentComplianceEntry, AgentDataUse, Manifest, Offering } from "../../src/sdk.js";

const offering = (over: Partial<Offering> = {}): Offering => ({
  id: "summarize",
  name: "Summarize",
  description: "Condense a document.",
  ...over,
});

const manifest = (over: Partial<Manifest> = {}): Manifest =>
  ({
    id: "UAAA",
    name: "Codex",
    description: "Writes code.",
    version: "1.0.0",
    protocol_version: "0.2.0",
    endpoint: "mesh.agent.UAAA.inbox",
    node: { id: "UNODE", attestation: {} },
    capabilities: [],
    offerings: [offering()],
    ...over,
  }) as unknown as Manifest;

describe("withStorefront", () => {
  it("leaves a manifest with no public block completely alone", () => {
    const m = manifest();
    expect(withStorefront(m)).toBe(m);
  });

  it("materializes descriptors for the advertised ids", () => {
    const m = manifest({
      offerings: [offering({ input_modes: ["application/pdf"], output_modes: ["text/plain"] })],
      public: { description: "Reads PDFs.", offerings: ["summarize"] },
    });
    const out = withStorefront(m);
    expect(out.public?.offering_details).toEqual([
      {
        id: "summarize",
        name: "Summarize",
        description: "Condense a document.",
        input_modes: ["application/pdf"],
        output_modes: ["text/plain"],
      },
    ]);
    // The selection itself is untouched — it is still a list of ids.
    expect(out.public?.offerings).toEqual(["summarize"]);
  });

  it("advertises only what the operator selected", () => {
    // §8.7: "advertising less than you can do is a choice this spec protects."
    const m = manifest({
      offerings: [offering(), offering({ id: "translate", name: "Translate" })],
      public: { offerings: ["translate"] },
    });
    expect(withStorefront(m).public?.offering_details?.map((d) => d.id)).toEqual(["translate"]);
  });

  it("drops an advertised id that matches no declared offering", () => {
    // A stale selection means the truthful storefront is the smaller one.
    const m = manifest({ public: { offerings: ["summarize", "gone"] } });
    expect(withStorefront(m).public?.offering_details?.map((d) => d.id)).toEqual(["summarize"]);
  });

  it("discards descriptors supplied by the registrant", () => {
    // The whole point of deriving: an agent must not be able to advertise an
    // interface it does not implement.
    const m = manifest({
      public: {
        offerings: ["summarize"],
        offering_details: [{ id: "summarize", name: "LIES", description: "Also does your taxes." }],
      },
    });
    expect(withStorefront(m).public?.offering_details?.[0]?.name).toBe("Summarize");
  });

  it("clears descriptors when nothing is advertised any more", () => {
    const m = manifest({
      public: {
        offerings: [],
        offering_details: [{ id: "summarize", name: "Summarize", description: "old" }],
      },
    });
    expect(withStorefront(m).public?.offering_details).toBeUndefined();
  });

  it("copies the card-level default modes into the storefront", () => {
    const m = manifest({
      default_input_modes: ["application/pdf", "text/plain"],
      default_output_modes: ["text/plain"],
      public: { description: "Reads PDFs." },
    });
    const out = withStorefront(m);
    expect(out.public?.default_input_modes).toEqual(["application/pdf", "text/plain"]);
    expect(out.public?.default_output_modes).toEqual(["text/plain"]);
  });

  it("does not invent modes for an agent that declared none", () => {
    // Silence must stay silence: an assumed mode is indistinguishable from a
    // declared one downstream.
    const out = withStorefront(manifest({ public: { description: "Quiet." } }));
    expect(out.public?.default_input_modes).toBeUndefined();
    expect(out.public?.default_output_modes).toBeUndefined();
  });

  it("returns the same object when there is nothing to change", () => {
    const m = manifest({ public: { description: "No offerings advertised." } });
    expect(withStorefront(m)).toBe(m);
  });

  it("returns the same object when the materialized fields already match", () => {
    const m = manifest({ public: { description: "d", offerings: ["summarize"] } });
    const once = withStorefront(m);
    expect(withStorefront(once)).toBe(once);
  });

  it("omits absent optional fields rather than writing undefined", () => {
    const out = withStorefront(manifest({ public: { offerings: ["summarize"] } }));
    const detail = out.public!.offering_details![0];
    expect(Object.keys(detail).sort()).toEqual(["description", "id", "name"]);
  });

  it("carries schemas, streaming and duration through", () => {
    const m = manifest({
      offerings: [
        offering({
          input_schema: { type: "object" },
          output_schema: { type: "string" },
          streaming: true,
          estimated_duration_ms: 1500,
          tags: ["docs"],
        }),
      ],
      public: { offerings: ["summarize"] },
    });
    const detail = withStorefront(m).public!.offering_details![0];
    expect(detail.input_schema).toEqual({ type: "object" });
    expect(detail.output_schema).toEqual({ type: "string" });
    expect(detail.streaming).toBe(true);
    expect(detail.estimated_duration_ms).toBe(1500);
    expect(detail.tags).toEqual(["docs"]);
  });

  it("never carries examples into a pre-admission document", () => {
    const m = manifest({
      offerings: [offering({ examples: [{ input: "a".repeat(5000), output: "b" }] })],
      public: { offerings: ["summarize"] },
    });
    expect(JSON.stringify(withStorefront(m).public!.offering_details)).not.toContain("aaaa");
  });

  it("caps how much a stranger can make describe return", () => {
    const many = Array.from({ length: 40 }, (_, i) => offering({ id: `s${i}` }));
    const m = manifest({ offerings: many, public: { offerings: many.map((s) => s.id) } });
    expect(withStorefront(m).public!.offering_details!.length).toBe(24);
  });

  it("ignores a duplicate id in the selection", () => {
    const m = manifest({ public: { offerings: ["summarize", "summarize"] } });
    expect(withStorefront(m).public!.offering_details!.length).toBe(1);
  });

  it("does not mutate the manifest it was given", () => {
    const m = manifest({ public: { offerings: ["summarize"] } });
    withStorefront(m);
    expect(m.public?.offering_details).toBeUndefined();
  });
});

// §8.7 `uis` (tracker #171): the operator-declared web surfaces. Validated
// per entry under the reporting family rule (an unreadable advertisement is a
// nothing, so the drop is per entry — registration never fails over a
// storefront link), with the per-FIELD softening for the optional prose and
// the offering binding ("dropped rather than invented", the §8.7 rule).
describe("the storefront uis (§8.7)", () => {
  const entry = (over: Partial<Record<keyof PublicUiEntry, unknown>> = {}): Record<string, unknown> => ({
    url: "https://dash.example/status",
    label: "Status board",
    ...over,
  });

  const withUis = (uis: unknown) =>
    manifest({ public: { description: "d", uis } as unknown as Manifest["public"] });

  it("carries a full entry through withStorefront, normalized to exactly the §8.7 members", () => {
    const m = withUis([
      entry({
        purpose: "Live progress of running tasks",
        audience: "client",
        access: "authenticated",
        kind: "dashboard",
        offering: "summarize",
        vendor_extra: "rides nowhere", // not a §8.7 member
      }),
    ]);
    const out = withStorefront(m).public as { uis?: PublicUiEntry[] };
    expect(out.uis).toEqual([
      {
        url: "https://dash.example/status",
        label: "Status board",
        purpose: "Live progress of running tasks",
        audience: "client",
        access: "authenticated",
        kind: "dashboard",
        offering: "summarize",
      },
    ]);
  });

  it("refuses http: the url is https-only, never coerced", () => {
    expect(readablePublicUis([entry({ url: "http://dash.example/status" })], new Set())).toEqual([]);
  });

  it("refuses credentials in the url", () => {
    expect(readablePublicUis([entry({ url: "https://user:pw@dash.example/" })], new Set())).toEqual([]);
    expect(readablePublicUis([entry({ url: "https://user@dash.example/" })], new Set())).toEqual([]);
  });

  it("drops an entry whose url is missing, unparseable, non-string, or over the cap", () => {
    for (const url of [undefined, "", "https://", "not a url", 3, null, ["https://x.example"], `https://x.example/${"a".repeat(300)}`]) {
      expect(readablePublicUis([entry({ url })], new Set()), JSON.stringify(url)).toEqual([]);
    }
  });

  it("drops an entry whose label is missing, blank, non-string, or over the cap", () => {
    for (const label of [undefined, "", "   ", 3, null, "x".repeat(61)]) {
      expect(readablePublicUis([entry({ label })], new Set()), JSON.stringify(label)).toEqual([]);
    }
    expect(readablePublicUis([entry({ label: "x".repeat(60) })], new Set())).toHaveLength(1);
  });

  it("drops the ENTRY on an audience or access outside the closed set — a label no renderer can place", () => {
    for (const audience of ["everyone", "OPERATOR", "", 3, null]) {
      expect(readablePublicUis([entry({ audience })], new Set()), JSON.stringify(audience)).toEqual([]);
    }
    for (const access of ["free", "OPEN", "", 3, null]) {
      expect(readablePublicUis([entry({ access })], new Set()), JSON.stringify(access)).toEqual([]);
    }
    for (const audience of ["public", "client", "operator"]) {
      expect(readablePublicUis([entry({ audience })], new Set())[0]?.audience, audience).toBe(audience);
    }
    for (const access of ["open", "authenticated"]) {
      expect(readablePublicUis([entry({ access })], new Set())[0]?.access, access).toBe(access);
    }
  });

  it("drops only the ENTRY, its neighbours surviving — never the manifest", () => {
    const out = readablePublicUis(
      [entry({ url: "http://insecure.example" }), entry({ label: "Kept" }), entry({ audience: "vip" })],
      new Set(),
    );
    expect(out.map((e) => e.label)).toEqual(["Kept"]);
    // And through the registry's own materialization: registration survives.
    const m = withUis([entry({ url: "http://insecure.example" }), entry({ label: "Kept" })]);
    const pub = withStorefront(m).public as { uis?: PublicUiEntry[] };
    expect(pub.uis?.map((e) => e.label)).toEqual(["Kept"]);
    expect(withStorefront(m).id).toBe("UAAA");
  });

  it("drops the offering FIELD when it names no declared offering — dropped rather than invented", () => {
    const declared = new Set(["summarize"]);
    expect(readablePublicUis([entry({ offering: "gone" })], declared)).toEqual([
      { url: "https://dash.example/status", label: "Status board" },
    ]);
    expect(readablePublicUis([entry({ offering: 3 })], declared)[0]?.offering).toBeUndefined();
    // A DECLARED offering binds even when unadvertised: the advertised-only
    // rule is the card emit's, not storage's (§8.7 declares, the card selects).
    const m = manifest({
      public: { offerings: [], uis: [entry({ offering: "summarize" })] } as unknown as Manifest["public"],
    });
    const pub = withStorefront(m).public as { uis?: PublicUiEntry[] };
    expect(pub.uis?.[0]?.offering).toBe("summarize");
  });

  it("drops an unreadable purpose or kind from the entry, the entry surviving", () => {
    for (const purpose of ["", "   ", "x".repeat(201), 3, null, ["p"]]) {
      const out = readablePublicUis([entry({ purpose })], new Set());
      expect(out, JSON.stringify(purpose)).toHaveLength(1);
      expect(out[0].purpose).toBeUndefined();
    }
    for (const kind of ["", "x".repeat(31), 3, null]) {
      const out = readablePublicUis([entry({ kind })], new Set());
      expect(out, JSON.stringify(kind)).toHaveLength(1);
      expect(out[0].kind).toBeUndefined();
    }
    // An unknown kind VALUE is fine: the vocabulary is open, values render
    // as-is, never refused.
    expect(readablePublicUis([entry({ kind: "holomap" })], new Set())[0]?.kind).toBe("holomap");
  });

  it("caps the list at 8 entries, dropped from the tail", () => {
    const many = Array.from({ length: 12 }, (_, i) => entry({ label: `Page ${i}`, url: `https://x.example/${i}` }));
    const out = readablePublicUis(many, new Set());
    expect(out).toHaveLength(8);
    expect(out[7].label).toBe("Page 7");
  });

  it("treats a non-array uis as undeclared, and clears a stale stored member", () => {
    for (const uis of ["https://x.example", {}, 3, true]) {
      const pub = withStorefront(withUis(uis)).public as { uis?: unknown };
      expect("uis" in (pub as object), JSON.stringify(uis)).toBe(false);
    }
    // All entries unreadable: the member clears rather than storing [].
    const pub = withStorefront(withUis([entry({ url: "http://x.example" })])).public as { uis?: unknown };
    expect("uis" in (pub as object)).toBe(false);
  });

  it("hands back the same object when the declared uis are already normalized", () => {
    const m = withUis([entry({ purpose: "Live status", audience: "public", access: "open", kind: "status" })]);
    const once = withStorefront(m);
    expect(withStorefront(once)).toBe(once);
  });

  it("does not mutate the manifest it was given", () => {
    const m = withUis([entry({ vendor_extra: "still here" })]);
    withStorefront(m);
    const raw = (m.public as { uis?: Array<Record<string, unknown>> }).uis;
    expect(raw?.[0]?.vendor_extra).toBe("still here");
  });
});

// §8.5.2 the offered reporting level — the one materialized field that is
// VALIDATED on the way in rather than passed through loose. The rules pinned
// here: a readable declaration is carried (normalized to level + every), an
// unreadable one is dropped from the stored manifest and the storefront while
// the offering itself survives, and an offering that never declared reporting
// materializes byte-identically to before the field existed.
describe("the offered reporting level (§8.5.2)", () => {
  const withReporting = (reporting: unknown) =>
    manifest({
      offerings: [offering({ reporting } as unknown as Partial<Offering>)],
      public: { offerings: ["summarize"] },
    });

  it("carries a readable check_ins declaration into the storefront", () => {
    const detail = withStorefront(withReporting({ level: "check_ins", every: "P1W" })).public!
      .offering_details![0];
    expect(detail.reporting).toEqual({ level: "check_ins", every: "P1W" });
  });

  it("carries the levels below check_ins without a cadence", () => {
    for (const level of ["records_only", "on_change"]) {
      const detail = withStorefront(withReporting({ level })).public!.offering_details![0];
      expect(detail.reporting, level).toEqual({ level });
    }
  });

  it("drops an unknown level — the offering survives", () => {
    const out = withStorefront(withReporting({ level: "hourly_vibes" }));
    const detail = out.public!.offering_details![0];
    expect(detail.id).toBe("summarize");
    expect(detail.reporting).toBeUndefined();
  });

  it("drops a malformed cadence rather than serving it", () => {
    // P1M is §5.12's named refusal (a calendar month is not a fixed span);
    // "weekly" is not the grammar at all.
    for (const every of ["P1M", "weekly", "P0D", ""]) {
      const out = withStorefront(withReporting({ level: "check_ins", every }));
      expect(out.public!.offering_details![0].reporting, every).toBeUndefined();
    }
  });

  it("drops check_ins declared without a calendar", () => {
    // §8.5.2: a calendar level advertised without a calendar advertises
    // nothing testable.
    const out = withStorefront(withReporting({ level: "check_ins" }));
    expect(out.public!.offering_details![0].reporting).toBeUndefined();
  });

  it("drops a cadence declared below check_ins", () => {
    for (const level of ["records_only", "on_change"]) {
      const out = withStorefront(withReporting({ level, every: "P1D" }));
      expect(out.public!.offering_details![0].reporting, level).toBeUndefined();
    }
  });

  it("normalizes to level and every: nothing else rides into the storefront", () => {
    const detail = withStorefront(
      withReporting({ level: "check_ins", every: "P3D", grade: "evidence", additions: ["risk register"] }),
    ).public!.offering_details![0];
    expect(detail.reporting).toEqual({ level: "check_ins", every: "P3D" });
  });

  it("is additive: an offering without reporting materializes byte-identically", () => {
    const plain = manifest({ public: { offerings: ["summarize"] } });
    expect(JSON.stringify(withStorefront(plain).public!.offering_details)).toBe(
      JSON.stringify([{ id: "summarize", name: "Summarize", description: "Condense a document." }]),
    );
  });

  it("scrubs an unreadable declaration from the manifest's own offerings", () => {
    // The stored manifest is served too (getManifest, discovery) — §8.5.2's
    // drop is from the stored manifest AND therefore the storefront.
    const m = manifest({
      offerings: [
        offering({ reporting: { level: "check_ins" } } as unknown as Partial<Offering>),
        offering({ id: "translate", name: "Translate", reporting: { level: "on_change" } } as unknown as Partial<Offering>),
      ],
    });
    const out = withReadableReporting(m);
    expect(out.offerings[0].reporting).toBeUndefined();
    expect(out.offerings[0].id).toBe("summarize"); // the offering survives
    expect(out.offerings[1].reporting).toEqual({ level: "on_change" }); // the readable one stays
    // And the input was not mutated.
    expect(m.offerings[0].reporting).toEqual({ level: "check_ins" });
  });

  it("hands back the same object when every declaration is readable", () => {
    const clean = manifest({
      offerings: [offering({ reporting: { level: "records_only" } } as unknown as Partial<Offering>)],
    });
    expect(withReadableReporting(clean)).toBe(clean);
    const silent = manifest();
    expect(withReadableReporting(silent)).toBe(silent);
  });

  it("readableReporting refuses the non-object shapes outright", () => {
    for (const bad of [null, "check_ins", 3, ["check_ins"], undefined]) {
      expect(readableReporting(bad), String(bad)).toBeNull();
    }
  });
});

// §8.10 the card-level data-use declaration. Same validated-on-the-way-in
// doctrine as reporting, one rule deliberately different and pinned hard here:
// the drop is WHOLE, never per-field — a partially readable privacy claim
// misleads more than none at all, so one unreadable member means the agent is
// served as having said nothing.
describe("the card-level data-use declaration (§8.10)", () => {
  const full: AgentDataUse = {
    promises: { no_training: true, no_third_party_sharing: true, no_human_reading: true },
    retention: { max_days: 30 },
    processors: [
      { service: "Anthropic API", domain: "anthropic.com", purpose: "model inference, zero-retention tier" },
    ],
    processed_in: ["us"],
  };

  it("carries the spec's own example through unchanged, as the same values", () => {
    expect(readableDataUse(full)).toEqual(full);
  });

  it("hands back the same object for an already-normalized declaration and for silence", () => {
    const declared = manifest({ data_use: full });
    expect(withReadableDataUse(declared)).toBe(declared);
    const silent = manifest();
    expect(withReadableDataUse(silent)).toBe(silent);
  });

  it("normalizes to exactly the §8.10 members: nothing else rides into storage", () => {
    // Grades are the clause's business (§5.11), transport is §8.9's, and a
    // processor's terms_url is nobody's — none of it reaches the stored form.
    const out = readableDataUse({
      promises: { no_training: true },
      retention: { max_days: 7, grade: "enforced" },
      processors: [{ service: "Acme Transcribe", domain: "acme.com", terms_url: "https://acme.com/terms" }],
      transport: { sealed: true, grade: "enforced" },
      grade: "recorded",
    });
    expect(out).toEqual({
      promises: { no_training: true },
      retention: { max_days: 7 },
      processors: [{ service: "Acme Transcribe", domain: "acme.com" }],
    });
  });

  it("preserves an empty processors list: content leaves for nowhere is a statement", () => {
    expect(readableDataUse({ processors: [] })).toEqual({ processors: [] });
    // And it is stable: already normalized, so the same object comes back.
    const declared = manifest({ data_use: { processors: [] } });
    expect(withReadableDataUse(declared)).toBe(declared);
  });

  it("refuses the non-object shapes outright", () => {
    for (const bad of [null, "no_training", 3, [full], undefined, true]) {
      expect(readableDataUse(bad), String(bad)).toBeNull();
    }
  });

  it("drops a promise spelled false, or spelled anything but the literal true", () => {
    // §5.11: false is not a value — it is spelled by omission.
    for (const spelled of [false, "true", "yes", 1, null, {}]) {
      expect(readableDataUse({ promises: { no_training: spelled } }), JSON.stringify(spelled)).toBeNull();
    }
  });

  it("drops an unknown promise name: the vocabulary is closed", () => {
    expect(readableDataUse({ promises: { no_selling: true } })).toBeNull();
    // Even beside three perfectly good promises — the drop is whole.
    expect(readableDataUse({ promises: { ...full.promises, no_vibes: true } })).toBeNull();
    // And a promises member that is not an object at all.
    expect(readableDataUse({ promises: ["no_training"] })).toBeNull();
    expect(readableDataUse({ promises: "no_training" })).toBeNull();
  });

  it("drops a retention ceiling that is not a positive safe integer", () => {
    for (const maxDays of [0, -1, 1.5, "30", null, NaN, Infinity, 2 ** 53]) {
      expect(readableDataUse({ retention: { max_days: maxDays } }), String(maxDays)).toBeNull();
    }
    expect(readableDataUse({ retention: {} })).toBeNull();
    expect(readableDataUse({ retention: 30 })).toBeNull();
    expect(readableDataUse({ retention: [30] })).toBeNull();
  });

  it("drops processors failing the §5.11 entry rules the SDK validator owns", () => {
    for (const processors of [
      {}, // not a list
      "Anthropic API",
      [{}], // an entry without its one required member
      [{ service: "" }], // blank
      [{ service: "x", domain: "" }], // blank optional is not absent
      [{ service: "x", purpose: "" }],
      [
        { service: "Acme", domain: "acme.com" },
        { service: "Acme", domain: "acme.com" }, // same service+domain twice
      ],
      Array.from({ length: 17 }, (_, i) => ({ service: `s${i}` })), // over the ceiling
    ]) {
      expect(readableDataUse({ processors }), JSON.stringify(processors)).toBeNull();
    }
  });

  it("drops WHOLE, never per-field: a readable promise does not survive an unreadable neighbour", () => {
    // The reporting rule (per-field, the offering survives) would keep
    // promises here. §8.10 says the opposite, on purpose: a page showing
    // "does not train" while silently losing the malformed retention half
    // shows a cleaner posture than was declared.
    const half = { promises: { no_training: true }, retention: { max_days: 0 } };
    expect(readableDataUse(half)).toBeNull();
    const m = manifest({ data_use: half as unknown as AgentDataUse });
    const out = withReadableDataUse(m);
    expect(out.data_use).toBeUndefined();
    // The manifest survives; only the declaration is gone — and the input
    // object was not mutated.
    expect(out.id).toBe("UAAA");
    expect(m.data_use).toEqual(half);
  });

  it("is additive: a manifest that never declared data_use is byte-identical through the scrub", () => {
    const silent = manifest();
    expect(JSON.stringify(withReadableDataUse(silent))).toBe(JSON.stringify(silent));
    expect("data_use" in withReadableDataUse(silent)).toBe(false);
  });

  // ── §8.10 `processed_in`: the jurisdictions content may touch ───────────

  it("carries processed_in through, lowercase and deduped", () => {
    expect(readableDataUse({ processed_in: ["us"] })).toEqual({ processed_in: ["us"] });
    expect(readableDataUse({ processed_in: ["us", "de", "us"] })).toEqual({ processed_in: ["us", "de"] });
    // Already normalized: the same object comes back through the scrub.
    const declared = manifest({ data_use: { processed_in: ["us", "de"] } });
    expect(withReadableCompliance(withReadableDataUse(declared))).toBe(declared);
  });

  it("drops a jurisdiction that is not exactly two lowercase ascii letters", () => {
    for (const code of ["US", "Us", "usa", "u", "u1", "ü1", "", " us", 3, null, ["us"]]) {
      expect(readableDataUse({ processed_in: [code] }), JSON.stringify(code)).toBeNull();
    }
    expect(readableDataUse({ processed_in: "us" })).toBeNull();
    expect(readableDataUse({ processed_in: { 0: "us" } })).toBeNull();
    // And one unreadable code beside a perfectly good one poisons the WHOLE
    // declaration, promises included — the §8.10 family rule.
    expect(readableDataUse({ promises: { no_training: true }, processed_in: ["us", "US"] })).toBeNull();
  });

  it("refuses an EMPTY processed_in: claiming content touches no jurisdiction is not a thing", () => {
    // §8.10 gives silence one meaning — absent fails any jurisdiction
    // requirement. An empty set would be a second spelling of silence that
    // reads as a STRONGER claim (it passes every buyer's subset test), so it
    // is unreadable, and per the family rule it poisons the declaration.
    expect(readableDataUse({ processed_in: [] })).toBeNull();
    expect(readableDataUse({ promises: { no_training: true }, processed_in: [] })).toBeNull();
    const m = manifest({ data_use: { promises: { no_training: true }, processed_in: [] } as AgentDataUse });
    expect(withReadableDataUse(m).data_use).toBeUndefined();
  });

  it("#148: an empty data_use object drops to absent instead of storing as {}", () => {
    // `{}` and absence both spell "has not said"; storage keeps one spelling.
    expect(readableDataUse({})).toBeNull();
    const m = manifest({ data_use: {} });
    const out = withReadableDataUse(m);
    expect("data_use" in out).toBe(false);
    expect(out.id).toBe("UAAA"); // the manifest survives
  });
});

// §8.11 the card-level compliance declarations. `data_use`'s sibling, under
// the same family rule: self-declared including the attestation pointer,
// absent means has-not-said, and one unreadable entry drops the WHOLE member
// — a partially readable claims list shows a posture nobody declared.
describe("the card-level compliance declarations (§8.11)", () => {
  const claims: AgentComplianceEntry[] = [
    {
      standard: "soc2",
      scope: "the hosted pipeline, Type II",
      attestation: { by: "Example Auditors LLP", url: "https://example.com/soc2", expires_at: "2027-03-01" },
    },
    { standard: "gdpr", scope: "as processor, under the engagement DPA" },
  ];

  it("carries the spec's own example through unchanged, as the same values", () => {
    expect(readableCompliance(claims)).toEqual(claims);
  });

  it("hands back the same object for an already-normalized declaration and for silence", () => {
    const declared = manifest({ compliance: claims });
    expect(withReadableCompliance(declared)).toBe(declared);
    const silent = manifest();
    expect(withReadableCompliance(silent)).toBe(silent);
  });

  it("normalizes to exactly the §8.11 members: nothing else rides into storage", () => {
    const out = readableCompliance([
      {
        standard: "hipaa",
        scope: "PHI intake only",
        badge: "platinum", // a member §8.11 does not have
        attestation: { by: "Example Auditors LLP", verified: true }, // nor this
      },
    ]);
    expect(out).toEqual([
      { standard: "hipaa", scope: "PHI intake only", attestation: { by: "Example Auditors LLP" } },
    ]);
    // An attestation with no members is a pointer at nobody: dropped to
    // absent rather than stored as {} — one spelling of silence.
    expect(readableCompliance([{ standard: "soc2", attestation: {} }])).toEqual([{ standard: "soc2" }]);
  });

  it("refuses the non-array shapes outright, and the empty array as a second spelling of silence", () => {
    for (const bad of [null, "soc2", 3, {}, { standard: "soc2" }, undefined, true]) {
      expect(readableCompliance(bad), String(bad)).toBeNull();
    }
    // [] would read as "declared, and claims nothing" — a shape absence
    // already spells. Same #148 rule the empty data_use object gets.
    expect(readableCompliance([])).toBeNull();
  });

  it("drops a standard that is not a lowercase token", () => {
    for (const standard of ["SOC2", "soc 2", "soc2!", "s", "-soc2", "a".repeat(33), "", 3, null, undefined]) {
      expect(readableCompliance([{ standard }]), JSON.stringify(standard)).toBeNull();
    }
    // The expected spellings of the usual suspects all pass the token shape.
    for (const standard of ["soc2", "iso27001", "gdpr", "hipaa", "pci-dss"]) {
      expect(readableCompliance([{ standard }]), standard).toEqual([{ standard }]);
    }
  });

  it("drops duplicate standards: comparison is exact token equality, one claim per standard", () => {
    expect(readableCompliance([{ standard: "soc2" }, { standard: "soc2", scope: "again" }])).toBeNull();
  });

  it("drops more than 16 entries", () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ standard: `std-${i}` }));
    expect(readableCompliance(many)).toBeNull();
    expect(readableCompliance(many.slice(0, 16))).toHaveLength(16);
  });

  it("drops a blank or over-long scope", () => {
    for (const scope of ["", "   ", "x".repeat(301), 3, null, ["scope"]]) {
      expect(readableCompliance([{ standard: "soc2", scope }]), JSON.stringify(scope)).toBeNull();
    }
    expect(readableCompliance([{ standard: "soc2", scope: "x".repeat(300) }])).not.toBeNull();
  });

  it("drops a malformed attestation: by, url and expires_at must be what they say", () => {
    const bads: unknown[] = [
      "Example Auditors", // not an object
      ["by"],
      { by: "" },
      { by: "   " },
      { by: "x".repeat(121) },
      { by: 3 },
      { url: "ftp://example.com/soc2" }, // http(s) only
      { url: "javascript:alert(1)" }, // a link a reader FOLLOWS must not be this
      { url: "https://" }, // scheme with nothing behind it
      { url: `https://example.com/${"x".repeat(300)}` },
      { url: 3 },
      { expires_at: "not a date" },
      { expires_at: 20270301 },
    ];
    for (const attestation of bads) {
      expect(readableCompliance([{ standard: "soc2", attestation }]), JSON.stringify(attestation)).toBeNull();
    }
    expect(readableCompliance([{ standard: "soc2", attestation: { by: "x".repeat(120) } }])).not.toBeNull();
    expect(readableCompliance([{ standard: "soc2", attestation: { url: "http://example.com/a" } }])).not.toBeNull();
  });

  it("drops WHOLE, never per-entry: a readable claim does not survive an unreadable neighbour", () => {
    const half = [claims[0], { standard: "NOT-A-TOKEN" }];
    expect(readableCompliance(half)).toBeNull();
    const m = manifest({ compliance: half as unknown as AgentComplianceEntry[] });
    const out = withReadableCompliance(m);
    expect(out.compliance).toBeUndefined();
    expect("compliance" in out).toBe(false); // gone, not nulled
    expect(out.id).toBe("UAAA"); // the manifest survives
    expect(m.compliance).toEqual(half); // and the input was not mutated
  });

  it("is additive: a manifest that never declared compliance is byte-identical through the scrub", () => {
    const silent = manifest();
    expect(JSON.stringify(withReadableCompliance(silent))).toBe(JSON.stringify(silent));
    expect("compliance" in withReadableCompliance(silent)).toBe(false);
  });
});

describe("the storefront access block (§8.12)", () => {
  const mesh = { id: "mesh", transport: "mesh", type: "mesh-identity" };
  const key = {
    id: "gateway-key", transport: "http", type: "apiKey",
    in: "header", name: "X-Api-Key", description: "issued once admitted",
  };

  it("keeps a readable block whole", () => {
    expect(readablePublicAccess({ admission: "screened", schemes: [mesh, key] })).toEqual({
      admission: "screened",
      schemes: [mesh, key],
    });
  });

  it("treats an unknown admission as UNSTATED, never as open", () => {
    const out = readablePublicAccess({ admission: "invite-only", schemes: [mesh] });
    expect(out).toEqual({ schemes: [mesh] });
    expect(out && "admission" in out).toBe(false);
  });

  // The three states of §8.12, which a reader must be able to tell apart.
  it("distinguishes declared-none from never-said", () => {
    expect(readablePublicAccess({ schemes: [] })).toEqual({ schemes: [] });
    expect(readablePublicAccess({})).toBeUndefined();
    expect(readablePublicAccess(undefined)).toBeUndefined();
    expect(readablePublicAccess({ admission: "open" })).toEqual({ admission: "open" });
  });

  // The defence is normalization: a smuggled secret never reaches storage, so
  // it never reaches the pre-admission page, where refusing the write later
  // would already be too late.
  it("rebuilds each scheme from the §8.12 members only, dropping anything else", () => {
    const out = readablePublicAccess({
      schemes: [{ ...key, api_key: "sk-live-do-not-publish", tenant: "acme-42" }],
    });
    expect(out?.schemes?.[0]).toEqual(key);
    expect(JSON.stringify(out)).not.toContain("sk-live");
    expect(JSON.stringify(out)).not.toContain("acme-42");
  });

  it("drops a scheme whose type does not belong to its transport", () => {
    expect(readablePublicAccess({
      schemes: [{ id: "a", transport: "mesh", type: "apiKey", in: "header", name: "X" }],
    })).toEqual({ schemes: [] });
    expect(readablePublicAccess({
      schemes: [{ id: "b", transport: "http", type: "mesh-identity" }],
    })).toEqual({ schemes: [] });
  });

  it("drops a scheme with no id, an unknown transport, or a duplicate id", () => {
    expect(readablePublicAccess({ schemes: [{ transport: "mesh", type: "mesh-identity" }] }))
      .toEqual({ schemes: [] });
    expect(readablePublicAccess({ schemes: [{ id: "a", transport: "carrier-pigeon", type: "apiKey" }] }))
      .toEqual({ schemes: [] });
    expect(readablePublicAccess({ schemes: [mesh, { ...mesh, description: "again" }] }))
      .toEqual({ schemes: [mesh] });
  });

  it("drops an apiKey scheme that names no header, and one with a bad `in`", () => {
    expect(readablePublicAccess({ schemes: [{ id: "k", transport: "http", type: "apiKey", in: "header" }] }))
      .toEqual({ schemes: [] });
    expect(readablePublicAccess({
      schemes: [{ id: "k", transport: "http", type: "apiKey", in: "body", name: "X" }],
    })).toEqual({ schemes: [] });
  });

  // The only URLs §8.12 admits are the operator's own, identical for every
  // caller. A `user:pass@` URL is a binding wearing a shape's clothes.
  it("drops an openIdConnect scheme whose URL is not a plain https address", () => {
    const oidc = (url: string) => readablePublicAccess({
      schemes: [{ id: "o", transport: "http", type: "openIdConnect", openIdConnectUrl: url }],
    });
    expect(oidc("https://id.example.com/.well-known/openid-configuration")?.schemes).toHaveLength(1);
    expect(oidc("http://id.example.com/c")).toEqual({ schemes: [] });
    expect(oidc("https://user:pass@id.example.com/c")).toEqual({ schemes: [] });
    expect(oidc("not-a-url")).toEqual({ schemes: [] });
  });

  it("rides through withStorefront, normalized, and clears a stale block", () => {
    const withAccess = withStorefront(manifest({
      public: { offerings: [], access: { admission: "open", schemes: [key] } },
    } as Partial<Manifest>));
    expect((withAccess.public as { access?: unknown }).access)
      .toEqual({ admission: "open", schemes: [key] });

    const unreadable = withStorefront(manifest({
      public: { offerings: [], access: { admission: "sometimes" } },
    } as Partial<Manifest>));
    expect("access" in (unreadable.public as object)).toBe(false);
  });
});
