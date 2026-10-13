// A file over the message size goes by signed link (§7.5, §18.9).
//
// Until 0.51.0 every file travelled base64 inside one NATS message, so the
// broker's 1 MB was the largest file anyone could store or read, and on
// 2026-09-23 a 3.6 MB video was dropped at delivery. These hold the client
// side of the fix: over ARTIFACT_INLINE_MAX a put is begin, HTTP PUT, commit;
// a fetch that comes back with a link follows it and checks the bytes exactly
// as it checks inline ones; everything at or under the limit is untouched.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  ARTIFACT_INLINE_MAX,
  ArtifactSubjects,
  artifactLink,
  fetchArtifact,
  putArtifact,
  type ArtifactHost,
} from "../../src/artifacts.js";
import { AgentMesh } from "../../src/mesh.js";
import { ErrorCode, MeshError } from "../../src/types/errors.js";

const digestOf = (b: Uint8Array): string => "sha256:" + createHash("sha256").update(b).digest("hex");
const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill);
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

interface Call {
  subject: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}

interface HttpCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

/** A host whose store answers from `answer`, and whose HTTP answers from
 *  `http`. Both record what they were asked. */
function stubHost(
  answer: (subject: string, payload: Record<string, unknown>) => unknown,
  http: (call: HttpCall) => Response = () => new Response(null, { status: 200 }),
) {
  const calls: Call[] = [];
  const httpCalls: HttpCall[] = [];
  const host: ArtifactHost = {
    async serviceRequest(subject, payload, timeoutMs) {
      calls.push({ subject, payload: payload as Record<string, unknown>, timeoutMs });
      const out = answer(subject, payload as Record<string, unknown>);
      if (out instanceof Error) throw out;
      return out;
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: HttpCall = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(init?.body ? { body: init.body as Uint8Array } : {}),
      };
      httpCalls.push(call);
      return http(call);
    }) as typeof fetch,
  };
  return { host, calls, httpCalls };
}

/** What the store says about a file it holds. */
const stored = (b: Uint8Array, extra: Record<string, unknown> = {}) => ({
  ref: "mesh:artifacts:AAAAAAAAAAAAAAAAAAAAAA",
  media_type: "video/mp4",
  size: b.byteLength,
  digest: digestOf(b),
  name: "video.mp4",
  expires_at: "2026-10-07T00:00:00.000Z",
  ...extra,
});

/** A store that hashes what it actually received, as the real one does: the
 *  base64 of an inline put, or the body that reached the upload link. */
function honestStore() {
  let uploaded: Uint8Array | undefined;
  return stubHost(
    (subject, payload) => {
      if (subject === ArtifactSubjects.PUT_BEGIN) {
        return { object_id: "o".repeat(22), ref: "mesh:artifacts:oooo", url: "https://storage.test/put" };
      }
      return stored(subject === ArtifactSubjects.PUT ? Buffer.from(payload.data_b64 as string, "base64") : uploaded!);
    },
    (call) => {
      uploaded = new Uint8Array(call.body!);
      return new Response(null, { status: 200 });
    },
  );
}

describe("ARTIFACT_INLINE_MAX", () => {
  it("is 512 KiB, which base64 and an envelope keep well under a 1 MiB broker", () => {
    expect(ARTIFACT_INLINE_MAX).toBe(512 * 1024);
    expect(Math.ceil(ARTIFACT_INLINE_MAX / 3) * 4 + 16 * 1024).toBeLessThan(1024 * 1024);
  });
});

describe("putArtifact", () => {
  it("sends a file at or under the limit inline, exactly as before", async () => {
    for (const size of [1, ARTIFACT_INLINE_MAX]) {
      const file = bytes(size);
      const { host, calls, httpCalls } = stubHost(() => stored(file));
      const out = await putArtifact(host, file, { media_type: "video/mp4", name: "video.mp4", retain_days: 30 });
      expect(out.digest).toBe(digestOf(file));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        subject: ArtifactSubjects.PUT,
        payload: { data_b64: b64(file), media_type: "video/mp4", name: "video.mp4", retain_days: 30 },
      });
      expect(httpCalls).toHaveLength(0);
    }
  });

  it("sends a file over the limit by begin, PUT to the signed link, and commit", async () => {
    const file = bytes(ARTIFACT_INLINE_MAX + 1, 3);
    const grant = {
      object_id: "AAAAAAAAAAAAAAAAAAAAAA",
      ref: "mesh:artifacts:AAAAAAAAAAAAAAAAAAAAAA",
      url: "https://storage.test/put/UOWNER/AAAAAAAAAAAAAAAAAAAAAA?sig=1",
      method: "PUT",
      headers: { "content-type": "video/mp4", "x-goog-content-length-range": `${file.byteLength},${file.byteLength}` },
    };
    const { host, calls, httpCalls } = stubHost((subject) =>
      subject === ArtifactSubjects.PUT_BEGIN ? grant : stored(file),
    );
    const out = await putArtifact(host, file, { media_type: "video/mp4", name: "video.mp4", retain_days: 30 });

    expect(calls.map((c) => c.subject)).toEqual([ArtifactSubjects.PUT_BEGIN, ArtifactSubjects.PUT_COMMIT]);
    // Begin declares everything put carries except the bytes.
    expect(calls[0]!.payload).toEqual({
      size: file.byteLength,
      digest: digestOf(file),
      media_type: "video/mp4",
      name: "video.mp4",
      retain_days: 30,
    });
    expect(calls[0]!.payload.data_b64).toBeUndefined();
    // The bytes go to the link, with the headers it was signed for.
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]).toMatchObject({ url: grant.url, method: "PUT", headers: grant.headers });
    expect(httpCalls[0]!.body).toBe(file);
    // Commit names the object and waits longer than an ordinary request.
    expect(calls[1]!.payload).toEqual({ object_id: grant.object_id });
    expect(calls[1]!.timeoutMs).toBeGreaterThan(30_000);
    // The same StoredArtifact an inline put returns.
    expect(out).toEqual(stored(file));
  });

  it("still refuses a commit reply whose digest is not the bytes sent", async () => {
    const file = bytes(ARTIFACT_INLINE_MAX + 1);
    const { host } = stubHost((subject) =>
      subject === ArtifactSubjects.PUT_BEGIN
        ? { object_id: "o".repeat(22), ref: "mesh:artifacts:x", url: "https://storage.test/put" }
        : stored(file, { digest: digestOf(bytes(1)) }),
    );
    await expect(putArtifact(host, file)).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
  });

  it("gives the reservation back and says so when the upload is refused", async () => {
    const file = bytes(ARTIFACT_INLINE_MAX + 1);
    const grant = { object_id: "o".repeat(22), ref: "mesh:artifacts:oooo", url: "https://storage.test/put" };
    const { host, calls } = stubHost(
      (subject) => (subject === ArtifactSubjects.PUT_BEGIN ? grant : { removed: true }),
      () => new Response("denied", { status: 403 }),
    );
    const err = await putArtifact(host, file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshError);
    expect((err as MeshError).code).toBe(ErrorCode.DEPENDENCY_FAILED);
    expect((err as MeshError).message).toContain("HTTP 403");
    expect(calls.map((c) => c.subject)).toEqual([ArtifactSubjects.PUT_BEGIN, ArtifactSubjects.REMOVE]);
    expect(calls[1]!.payload).toEqual({ ref: grant.ref });
  });

  it("falls back to the inline put when the store or the credential predates links", async () => {
    for (const code of [ErrorCode.TRANSPORT_NO_RESPONDERS, ErrorCode.TRANSPORT_PERMISSION_DENIED]) {
      const file = bytes(ARTIFACT_INLINE_MAX + 1);
      const { host, calls, httpCalls } = stubHost((subject) =>
        subject === ArtifactSubjects.PUT_BEGIN ? new MeshError(code, "old") : stored(file),
      );
      await putArtifact(host, file);
      expect(calls.map((c) => c.subject)).toEqual([ArtifactSubjects.PUT_BEGIN, ArtifactSubjects.PUT]);
      expect(calls[1]!.payload.data_b64).toBe(b64(file));
      expect(httpCalls).toHaveLength(0);
    }
  });

  it("does not fall back on a refusal, which the inline put would only repeat", async () => {
    const file = bytes(ARTIFACT_INLINE_MAX + 1);
    const { host, calls } = stubHost(() => new MeshError(ErrorCode.QUOTA_EXCEEDED, "full"));
    await expect(putArtifact(host, file)).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED });
    expect(calls).toHaveLength(1);
  });

  // 2026-09-24: the platform stored a 3 KB JSON file as `Buffer.from(json)` and
  // was told the store's digest was not the bytes sent. The store was right;
  // the local hash had covered Node's shared buffer pool instead of the file.
  it("hashes a small pooled Buffer over its own bytes, not the pool around it", async () => {
    const json = Buffer.from('{"some":"json"}', "utf8");
    // The trap needs a pooled Buffer: a view onto a larger block of memory.
    expect(json.buffer.byteLength).toBeGreaterThan(json.byteLength);
    const { host } = honestStore();
    const out = await putArtifact(host, json, { media_type: "application/json" });
    expect(out.digest).toBe(digestOf(json));
  });

  it("hashes a Buffer subarray from its byteOffset, inline and by link", async () => {
    for (const size of [64, ARTIFACT_INLINE_MAX + 64]) {
      const whole = Buffer.alloc(size + 32);
      for (let i = 0; i < whole.length; i++) whole[i] = i % 251;
      const part = whole.subarray(32);
      expect(part.byteOffset).toBe(32);
      const { host } = honestStore();
      const out = await putArtifact(host, part);
      expect(out.digest).toBe(digestOf(part));
      expect(out.size).toBe(size);
    }
  });
});

describe("fetchArtifact", () => {
  it("says it can follow a link, and reads an inline reply as before", async () => {
    const file = bytes(40);
    const { host, calls, httpCalls } = stubHost(() => ({ ...stored(file), data_b64: b64(file) }));
    const got = await fetchArtifact(host, "mesh:artifacts:x");
    expect(calls[0]).toMatchObject({ subject: ArtifactSubjects.FETCH, payload: { ref: "mesh:artifacts:x", links: true } });
    expect(got.data).toEqual(file);
    expect(httpCalls).toHaveLength(0);
  });

  it("follows a link and checks the bytes exactly as inline ones", async () => {
    const file = bytes(ARTIFACT_INLINE_MAX + 5, 9);
    const url = "https://storage.test/get/x?sig=1";
    const { host, httpCalls } = stubHost(
      () => ({ ...stored(file), url }),
      () => new Response(file, { status: 200 }),
    );
    const got = await fetchArtifact(host, "mesh:artifacts:x");
    expect(httpCalls).toEqual([{ url, method: "GET", headers: {} }]);
    expect(got.data).toEqual(file);
    expect(got).toMatchObject({ size: file.byteLength, digest: digestOf(file), name: "video.mp4" });
    expect("url" in got).toBe(false);
  });

  it("rejects linked bytes whose digest is not the one announced", async () => {
    const file = bytes(100, 1);
    const { host } = stubHost(
      () => ({ ...stored(file), url: "https://storage.test/get/x" }),
      () => new Response(bytes(100, 2), { status: 200 }),
    );
    await expect(fetchArtifact(host, "mesh:artifacts:x")).rejects.toThrow(/hash to/);
  });

  it("rejects linked bytes whose length is not the one announced", async () => {
    const file = bytes(100, 1);
    const short = bytes(99, 1);
    const { host } = stubHost(
      () => ({ ...stored(file), digest: digestOf(short), url: "https://storage.test/get/x" }),
      () => new Response(short, { status: 200 }),
    );
    await expect(fetchArtifact(host, "mesh:artifacts:x")).rejects.toThrow(/100 bytes but 99 arrived/);
  });

  it("fails a link the storage will not serve", async () => {
    const { host } = stubHost(
      () => ({ ...stored(bytes(1)), url: "https://storage.test/get/x" }),
      () => new Response(null, { status: 404 }),
    );
    await expect(fetchArtifact(host, "mesh:artifacts:x")).rejects.toMatchObject({ code: ErrorCode.DEPENDENCY_FAILED });
  });
});

describe("artifactLink", () => {
  it("asks for a link to a ref, with the name to save it under", async () => {
    const answer = { ...stored(bytes(1)), url: "https://storage.test/get/x", expires_at: "2026-09-23T16:00:00.000Z" };
    const { host, calls } = stubHost(() => answer);
    expect(await artifactLink(host, "mesh:artifacts:x", { download_name: "clip.mp4" })).toEqual(answer);
    expect(calls[0]).toEqual({
      subject: ArtifactSubjects.LINK,
      payload: { ref: "mesh:artifacts:x", download_name: "clip.mp4" },
      timeoutMs: undefined,
    });
    await artifactLink(host, "mesh:artifacts:y");
    expect(calls[1]!.payload).toEqual({ ref: "mesh:artifacts:y" });
  });

  it("is on the agent, beside putArtifact", () => {
    expect(typeof AgentMesh.prototype.artifactLink).toBe("function");
    expect(typeof AgentMesh.prototype.putArtifact).toBe("function");
  });
});
