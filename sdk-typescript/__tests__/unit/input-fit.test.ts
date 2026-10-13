import { describe, expect, it } from "vitest";
import {
  INPUT_NOT_UNDERSTOOD,
  applyConversion,
  cardText,
  checkConversion,
  conversionRequest,
  exampleFor,
  fitCheck,
  inputNotUnderstood,
  isHelpQuestion,
  isScripted,
  isRunnerLine,
  isYes,
  needsConfirmation,
  offeringsFromDescriptor,
  offeringsFromManifest,
  readAsLine,
  type DeclaredOffering,
} from "../../src/index.js";
import { ErrorCode } from "../../src/types/errors.js";

// The shapes the builder writes into a package's descriptor (build.py project()).
const factWriter = offeringsFromDescriptor({
  offerings: [{
    id: "write-facts",
    name: "Write facts",
    does: "Turns a site-read into sourced facts.",
    inputs: [
      { name: "site-read", kind: "application/json", required: true },
      { name: "subject", kind: "application/json", required: false },
      { name: "posting", kind: "application/json", required: false },
    ],
  }],
});
const siteReader = offeringsFromDescriptor({
  offerings: [{
    id: "read-site", name: "Read a site",
    inputs: [
      { name: "url", kind: "url", required: true },
      { name: "max_pages", kind: "text", required: false },
    ],
  }],
});
const cnbc = "Please extract sourced facts from this page: https://www.cnbc.com/2026/09/28/amd-fei-fei-li-world-labs.html, for every claim one plain sentence, the questions it answers, and the verbatim quote";

describe("the fit check", () => {
  it("a sentence carries no site-read, so it does not fit and says what is missing", () => {
    const r = fitCheck({ offerings: factWriter, text: cnbc, files: [] });
    expect(r.fits).toBe(false);
    expect(r.reason).toBe("missing_input");
    expect(r.missing).toEqual(["site-read"]);
  });

  it("an attached site-read fits, by name or by media type", () => {
    expect(fitCheck({ offerings: factWriter, text: "here", files: [{ name: "site-read.json", media_type: "application/json" }] }).fits).toBe(true);
    expect(fitCheck({ offerings: factWriter, text: "", files: [{ name: "pages", media_type: "application/json" }] }).fits).toBe(true);
  });

  it("a url input is present when the words hold an address", () => {
    expect(fitCheck({ offerings: siteReader, text: "read https://acme.example please" }).fits).toBe(true);
    const r = fitCheck({ offerings: siteReader, text: "read the acme site please" });
    expect(r.fits).toBe(false);
    expect(r.missing).toEqual(["url"]);
  });

  it("a whole message of JSON, or name: value lines, states fields", () => {
    expect(fitCheck({ offerings: factWriter, text: JSON.stringify({ "site-read": { pages: [] } }) }).fits).toBe(true);
    const near = fitCheck({ offerings: factWriter, text: JSON.stringify({ subject: { name: "AMD" } }) });
    expect(near.fits).toBe(false);
    expect(near.missing).toEqual(["site-read"]);
    expect(fitCheck({ offerings: siteReader, text: "url: https://a.example" }).fits).toBe(true);
  });

  it("a one_of group needs one member, and optional-only inputs need at least one", () => {
    const grouped: DeclaredOffering[] = [{ id: "read", inputs: [
      { name: "page", kind: "url", one_of: "source" },
      { name: "pdf", kind: "application/pdf", one_of: "source" },
    ] }];
    expect(fitCheck({ offerings: grouped, text: "nothing here" }).missing).toEqual(["one of: page, pdf"]);
    expect(fitCheck({ offerings: grouped, text: "", files: [{ name: "x.pdf", media_type: "application/pdf" }] }).fits).toBe(true);
    // Optional inputs only: the offering needs nothing, so the agent answers it itself.
    const optional: DeclaredOffering[] = [{ id: "o", inputs: [{ name: "doc", kind: "application/pdf" }] }];
    expect(fitCheck({ offerings: optional, text: "hello" }).fits).toBe(true);
  });

  it("the offering is the one named, the only one, or the one the words say; otherwise unclear", () => {
    const two: DeclaredOffering[] = [{ id: "a", name: "Alpha", inputs: [] }, { id: "b", name: "Beta", inputs: [] }];
    expect(fitCheck({ offerings: two, named: "b", text: "x" }).offering?.id).toBe("b");
    expect(fitCheck({ offerings: two, text: "please do beta" }).offering?.id).toBe("b");
    const r = fitCheck({ offerings: two, text: "hello" });
    expect(r.reason).toBe("offering_unclear");
  });

  it("help questions are the whole message only; runner lines and yeses are recognised", () => {
    expect(isHelpQuestion("What can you do?")).toBe(true);
    expect(isHelpQuestion("hi, how do I use you")).toBe(true);
    expect(isHelpQuestion("help me write facts from this page")).toBe(false);
    expect(isRunnerLine("run r-20260928-ab12 phase write-the-facts: stop that")).toBe(true);
    expect(isYes("Yes, go ahead")).toBe(true);
    expect(isYes("yesterday I sent a long message about the thing")).toBe(false);
  });
});

describe("the standard reply", () => {
  it("names what went wrong, what it takes and an example, with fixed fields for agents", () => {
    const r = inputNotUnderstood({ agent: "fact-writer", offerings: factWriter, offering: factWriter[0], reason: "missing_input", missing: ["site-read"], readAs: "a request to write facts from https://www.cnbc.com/x" });
    expect(r.error.code).toBe(INPUT_NOT_UNDERSTOOD);
    expect(String(ErrorCode.INPUT_NOT_UNDERSTOOD)).toBe(INPUT_NOT_UNDERSTOOD);
    expect(r.text).toContain("fact-writer could not use this message, which reads as a request to write facts");
    expect(r.text).toContain("site-read (a JSON file)");
    expect(r.text).toContain("For example:");
    expect(r.text).not.toMatch(/—/);
    expect(r.error.details).toMatchObject({ reason: "missing_input", offering: "write-facts", missing: ["site-read"] });
    expect(r.error.details.expected?.[0]).toMatchObject({ name: "site-read", required: true });
    expect(r.error.retryable).toBe(false);
  });

  it("an example is the declared one, or made from the inputs", () => {
    expect(exampleFor(factWriter[0])).toBe("Write facts, with site-read.json attached");
    expect(exampleFor(siteReader[0])).toBe("Read a site https://example.com");
    expect(exampleFor({ id: "x", examples: ["Do x with y"], inputs: [] })).toBe("Do x with y");
  });

  it("the card answer lists the offerings with what each takes and an example", () => {
    const t = cardText({ name: "fact-writer", does: "Turns a site-read into sourced facts.", offerings: factWriter, howToUse: "https://console.example/a/K/agentdoc" });
    expect(t).toContain("Write facts (write-facts)");
    expect(t).toContain("It takes: site-read (a JSON file, required)");
    expect(t).toContain("no model involved");
  });

  it("a descriptor offering carries how its work is controlled; two missing inputs read as them", () => {
    const o = offeringsFromDescriptor({ offerings: [{ id: "a", inputs: [], how: { control: "script" } }, { id: "b", inputs: [] }] });
    expect(o.map((x) => [x.id, isScripted(x)])).toEqual([["a", true], ["b", false]]);
    const two = inputNotUnderstood({ agent: "fact-checker", offerings: factWriter, offering: { id: "c", name: "Check facts", inputs: [{ name: "facts", kind: "application/json", required: true }, { name: "site-read", kind: "application/json", required: true }] }, reason: "missing_input", missing: ["facts", "site-read"] });
    expect(two.text).toContain("does not carry them");
  });

  it("manifest offerings read their JSON schema as inputs", () => {
    const o = offeringsFromManifest({ offerings: [{ id: "ring.start", input_schema: { type: "object", properties: { opening: { type: "string" }, lap: { type: "object" } }, required: ["opening"] } }] });
    expect(o[0].inputs).toEqual([{ name: "opening", kind: "text", required: true }, { name: "lap", kind: "application/json" }]);
  });
});

describe("checking the converter's answer", () => {
  const site = siteReader[0];
  const text = "could you read the pages at https://acme.example for me";

  it("a filled field that rests on the sender's words is used", () => {
    const c = checkConversion({ result: "filled", read_as: "read https://acme.example", fields: { url: { value: "https://acme.example", confidence: 0.95, from: "https://acme.example" } } }, { offering: site, text });
    expect(c.ok).toBe(true);
    if (c.ok) {
      const a = applyConversion(text, c.fields, site);
      expect(a.text.startsWith("url: https://acme.example\n\n")).toBe(true);
      expect(readAsLine(c.readAs, c.fields, false)).toBe("I read this as: read https://acme.example. Working on it.");
    }
  });

  it("an invented address, an undeclared field or a weak field is dropped", () => {
    const invented = checkConversion({ result: "filled", fields: { url: { value: "https://other.example", confidence: 0.99, from: "the pages" } } }, { offering: site, text });
    expect(invented.ok).toBe(false);
    const undeclared = checkConversion({ result: "filled", fields: { url: { value: "https://acme.example", confidence: 0.9, from: "https://acme.example" }, secret: { value: "x", confidence: 1, from: "me" } } }, { offering: site, text });
    expect(undeclared.ok).toBe(true);
    if (undeclared.ok) expect(Object.keys(undeclared.fields)).toEqual(["url"]);
    const weak = checkConversion({ result: "filled", fields: { url: { value: "https://acme.example", confidence: 0.4, from: "https://acme.example" } } }, { offering: site, text });
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.missing).toEqual(["url"]);
  });

  it("missing and not a request become the standard reply's reasons", () => {
    const m = checkConversion({ result: "missing", read_as: "a request to write facts from a CNBC page", fields: {}, missing: ["site-read"] }, { offering: factWriter[0], text: cnbc });
    expect(m).toMatchObject({ ok: false, reason: "missing_input", missing: ["site-read"], readAs: "a request to write facts from a CNBC page" });
    const n = checkConversion({ result: "not_a_request", why: "noise" }, { offering: factWriter[0], text: "zxq" });
    expect(n).toMatchObject({ ok: false, reason: "not_a_request" });
    expect(checkConversion(null, { offering: factWriter[0], text: "" }).ok).toBe(false);
  });

  it("a JSON field travels as a file, and the request names files without their contents", () => {
    const off = factWriter[0];
    const c = checkConversion({ result: "filled", fields: { "site-read": { value: { pages: [{ url: "https://a.example", text: "words" }] }, confidence: 0.9, from: "words" } } }, { offering: off, text: "the words" });
    expect(c.ok).toBe(true);
    if (c.ok) expect(applyConversion("the words", c.fields, off).files[0]).toMatchObject({ name: "site-read.json", media_type: "application/json" });
    const req = conversionRequest({ text: "t", files: [{ name: "a.pdf", media_type: "application/pdf" }], agent: "fact-writer.platform@agentmesh.ai", offering: off });
    expect(req).toMatchObject({ convert: "v1", files: [{ name: "a.pdf", media_type: "application/pdf" }], target: { offering: { id: "write-facts" } } });
  });

  it("costly or long work is confirmed first", () => {
    expect(needsConfirmation({ priceMicro: 0, jobSeconds: 180 })).toBe(false);
    expect(needsConfirmation({ priceMicro: 250000 })).toBe(true);
    expect(needsConfirmation({ jobSeconds: 1500 })).toBe(true);
  });
});
