// The dossier: what survives a room.
//
// Two things are worth testing and they are different. Which files count as
// outputs — because that decides what keeps its bytes and what keeps only a
// digest. And whether the thing verifies offline — because a signed artifact
// nobody can check is just a file with a signature field in it.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildDossier, roleOf, verifyDossier, DOSSIER_SIG_PREFIX } from "../../src/rooms/dossier.js";
import { nkeys, verifyTagged, fromB64Url } from "../../src/sdk.js";

const say = (body: string) => ({ type: "say", body });
const digestOf = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

const fileOf = (over: Partial<Record<string, unknown>> = {}) => ({
  ref: "mesh:rooms:r1/drive/one",
  name: "debrief.md",
  version: "v2",
  digest: digestOf("body"),
  media_type: "text/markdown",
  size: 4,
  attached_by: "UAAA",
  attached_at: "2026-08-01T00:00:00Z",
  origin: null,
  ...over,
});

describe("roleOf", () => {
  const record = [
    say("Here is the brief I already had."),
    say("DELIVERABLE · draft · @ v1 · ref: mesh:rooms:r1/drive/d1"),
    say("DELIVERABLE · revision · @ v2 · ref: mesh:rooms:r1/drive/d2"),
    say("ACCEPTED · deliverable: revision @ v2"),
  ];
  const files = [
    { ref: "mesh:rooms:r1/drive/brief", name: "brief.md", version: "1" },
    { ref: "mesh:rooms:r1/drive/d1", name: "debrief.md", version: "v1" },
    { ref: "mesh:rooms:r1/drive/d2", name: "debrief.md", version: "v2" },
  ];

  it("separates brought-in, superseded and accepted", () => {
    const r = roleOf(files, record);
    expect(r.get("mesh:rooms:r1/drive/brief")).toBe("input");
    expect(r.get("mesh:rooms:r1/drive/d1")).toBe("interim");
    expect(r.get("mesh:rooms:r1/drive/d2")).toBe("output");
  });

  it("calls everything an input in a room that claimed nothing", () => {
    const r = roleOf(files, [say("hello"), say("hi")]);
    expect([...r.values()].every((v) => v === "input")).toBe(true);
  });
});

describe("buildDossier", () => {
  const signer = nkeys.createUser();
  const record = [
    { seq: 1, ts: "t", from: "UAAA", type: "genesis" },
    { seq: 2, ts: "t", from: "UAAA", type: "say", body: "DELIVERABLE · revision · @ v2 · ref: mesh:rooms:r1/drive/one" },
    { seq: 3, ts: "t", from: "UBBB", type: "say", body: "ACCEPTED · deliverable: revision @ v2" },
  ];
  const base = {
    room_id: "r1",
    room_name: "debrief",
    creator: "UAAA",
    operator: "someone@example.com",
    created_at: "2026-08-01T00:00:00Z",
    closed_at: "2026-08-01T01:00:00Z",
    why: "reclaimed by creator",
    record,
    signer,
  };

  it("keeps bytes for the output and digests for the rest", async () => {
    const d = await buildDossier({
      ...base,
      files: [fileOf(), fileOf({ ref: "mesh:rooms:r1/drive/two", name: "brief.md", version: "1" })],
      readBytes: async () => new TextEncoder().encode("body"),
    });
    const out = d.files.find((f) => f.role === "output")!;
    const input = d.files.find((f) => f.role === "input")!;
    expect(out.data_b64).toBeTruthy();
    // The input keeps its digest and loses its bytes. That is the trade the
    // whole design rests on, so it gets an assertion rather than a comment.
    expect(input.data_b64).toBeUndefined();
    expect(input.digest).toBeTruthy();
    expect(d.manifest.outputs).toBe(1);
  });

  it("records an output whose bytes are already gone as an output with none", async () => {
    // Not demoted, not dropped: the room DID accept it. A dossier that rewrote
    // that to match what it could still read would be editing history to fit
    // its storage.
    const d = await buildDossier({ ...base, files: [fileOf()], readBytes: async () => null });
    expect(d.files[0]!.role).toBe("output");
    expect(d.files[0]!.data_b64).toBeUndefined();
  });

  it("verifies offline with nothing but the signer's public key", async () => {
    const d = await buildDossier({
      ...base,
      files: [fileOf()],
      readBytes: async () => new TextEncoder().encode("body"),
    });
    const check = (pub: string, prefix: string, msg: string, sig: string) =>
      verifyTagged(pub, prefix, msg, fromB64Url(sig));
    expect(verifyDossier(d, check)).toEqual([]);
    expect(DOSSIER_SIG_PREFIX).toContain("agentmesh-room-dossier-v1");
  });

  it("catches a record edited after signing", async () => {
    const d = await buildDossier({ ...base, files: [fileOf()], readBytes: async () => null });
    d.record[1]!.body = "DELIVERABLE · revision · @ v9 · ref: elsewhere";
    const check = (pub: string, prefix: string, msg: string, sig: string) =>
      verifyTagged(pub, prefix, msg, fromB64Url(sig));
    expect(verifyDossier(d, check)).toContain("the record does not match entries_sha256");
  });

  it("catches output bytes that do not hash to their digest", async () => {
    const d = await buildDossier({
      ...base,
      files: [fileOf()],
      readBytes: async () => new TextEncoder().encode("body"),
    });
    d.files[0]!.data_b64 = Buffer.from("tampered").toString("base64");
    const check = (pub: string, prefix: string, msg: string, sig: string) =>
      verifyTagged(pub, prefix, msg, fromB64Url(sig));
    const bad = verifyDossier(d, check);
    // Two independent alarms: the file list no longer matches its own digest,
    // and the bytes no longer match the file's. Either alone should be enough.
    expect(bad.some((b) => b.includes("files_sha256"))).toBe(true);
    expect(bad.some((b) => b.includes("bytes hash to"))).toBe(true);
  });
});
