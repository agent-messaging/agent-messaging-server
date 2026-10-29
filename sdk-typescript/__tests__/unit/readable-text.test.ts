/**
 * Readable text generated from a signed message (Agent Messaging §5.8): the
 * normalization, the digest, the text for a message written to a person, and
 * the check software runs before it shows such text.
 */
import { describe, expect, it } from "vitest";
import {
  checkReadableText,
  normalizeReadableText,
  personReadableText,
  readableTextDigest,
  readableTextMeta,
} from "../../src/readable-text.js";

const FROM = "UAGENTSENDERSENDERSENDERSENDERSENDERSENDERSENDERSENDERSE";

describe("normalizeReadableText", () => {
  it("makes line endings LF, trims line ends and drops trailing empty lines", () => {
    expect(normalizeReadableText("a  \r\nb\t\r\n\r\n\n")).toBe("a\nb");
    expect(normalizeReadableText("a\rb")).toBe("a\nb");
  });

  it("keeps leading spaces and inner empty lines", () => {
    expect(normalizeReadableText("  a\n\nb")).toBe("  a\n\nb");
  });
});

describe("readableTextDigest", () => {
  it("is sha256 of the normalized text, so carriage returns and trailing blanks do not change it", async () => {
    const a = await readableTextDigest("Hello\nworld");
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await readableTextDigest("Hello  \r\nworld\r\n\r\n")).toBe(a);
    expect(await readableTextDigest("Hello\nWorld")).not.toBe(a);
  });

  it("matches a known vector (the empty text)", async () => {
    expect(await readableTextDigest("")).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("personReadableText", () => {
  it("states the sender, the text word for word, and each file", () => {
    expect(personReadableText({ sender: "Scheduler.ana@example.org", text: "Lunch at noon?", files: ["menu.pdf"] })).toBe(
      "From Scheduler.ana@example.org\n\nLunch at noon?\n\nAttached: menu.pdf",
    );
  });
});

describe("checkReadableText", () => {
  const text = personReadableText({ sender: FROM, text: "Lunch at noon?" });

  it("passes when the digest is signed and the text states what it must", async () => {
    const env = { from: FROM, payload: { text: "Lunch at noon?" }, meta: { audience: "person", readable_text: await readableTextMeta(text) } };
    expect(await checkReadableText(env, text)).toEqual({ ok: true });
  });

  it("fails on text that differs from the signed digest", async () => {
    const env = { from: FROM, payload: { text: "Lunch at noon?" }, meta: { readable_text: await readableTextMeta(text) } };
    const r = await checkReadableText(env, text.replace("noon", "one"));
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.reasons).toContain("digest_mismatch");
    expect(r.ok ? [] : r.reasons).toContain("text_missing");
  });

  it("fails when no digest was signed", async () => {
    const r = await checkReadableText({ from: FROM, payload: { text: "Lunch at noon?" } }, text);
    expect(r.ok ? [] : r.reasons).toEqual(["no_digest"]);
  });

  it("reads Agent Emailing's own member as the digest", async () => {
    const env = { from: FROM, payload: { text: "Lunch at noon?" }, meta: { agent_emailing: { human_text: await readableTextDigest(text) } } };
    expect(await checkReadableText(env, text)).toEqual({ ok: true });
  });

  it("fails when a file the envelope carries is not named", async () => {
    const env = {
      from: FROM,
      payload: { text: "Lunch at noon?", files: [{ name: "menu.pdf", ref: "x" }] },
      meta: { readable_text: await readableTextMeta(text) },
    };
    const r = await checkReadableText(env, text);
    expect(r.ok ? [] : r.reasons).toEqual(["file_missing"]);
  });
});
