import { describe, expect, it } from "vitest";
import { HeldStore } from "../../src/admission/held-store.js";

/** A KV that remembers, enough for the keyed get/put/purge paths. */
function fakeKv() {
  const rows = new Map<string, string>();
  const kv = {
    rows,
    async get(k: string) { const v = rows.get(k); return v === undefined ? null : { length: v.length, string: () => v }; },
    async put(k: string, v: string) { rows.set(k, v); },
    async purge(k: string) { rows.delete(k); },
  };
  return { kv: kv as unknown as ConstructorParameters<typeof HeldStore>[0] };
}

const AGENT = "U".padEnd(56, "A");
const SENDER = "U".padEnd(56, "S");

describe("a knock report carries one line of the sender's words, and the newest words win", () => {
  it("stores the line, the file count and the via with the first report", async () => {
    const { kv } = fakeKv();
    const store = new HeldStore(kv);
    await store.report(AGENT, SENDER, "brief-writer.acme.example", "Acme Studio", undefined,
      { line: "Please write a brief for the attached transcript.", files: 2, via: "in the catalog" });
    // listWaiting enumerates the bucket, which the fake cannot; read the row back by key instead.
    const got = JSON.parse(fakeRowsOf(kv).get(`${AGENT}.${SENDER}`)!);
    expect(got.line).toBe("Please write a brief for the attached transcript.");
    expect(got.files).toBe(2);
    expect(got.via).toBe("in the catalog");
    expect(got.count).toBe(1);
  });

  it("a repeat knock that says something replaces the line; one that says nothing keeps it", async () => {
    const { kv } = fakeKv();
    const store = new HeldStore(kv);
    await store.report(AGENT, SENDER, "scout.northwind.example", null, undefined, { line: "First ask.", files: 1 });
    await store.report(AGENT, SENDER, "scout.northwind.example", null, undefined, {});
    let got = JSON.parse(fakeRowsOf(kv).get(`${AGENT}.${SENDER}`)!);
    expect(got.count).toBe(2);
    expect(got.line).toBe("First ask.");
    await store.report(AGENT, SENDER, "scout.northwind.example", null, undefined, { line: "Second ask, no files." });
    got = JSON.parse(fakeRowsOf(kv).get(`${AGENT}.${SENDER}`)!);
    expect(got.count).toBe(3);
    expect(got.line).toBe("Second ask, no files.");
    expect(got.files).toBe(0);
  });
});

function fakeRowsOf(kv: unknown): Map<string, string> {
  return (kv as { rows: Map<string, string> }).rows;
}
