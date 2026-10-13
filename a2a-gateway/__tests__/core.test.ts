import { describe, it, expect } from "vitest";
import { partsToInput, outputToParts, refToUrl, linkFiles, meshLinker, FileStoreError, type FileSink } from "../src/core/parts.js";
import { meshStateToA2A, a2aStateToMesh } from "../src/core/states.js";
import { meshErrorToRpc, rpcErrorToMesh } from "../src/core/errors.js";
import { manifestToCard, cardToManifestFields, jsonRpcInterfaceUrl, BRIDGE_EXTENSION_URI } from "../src/core/card.js";
import { RpcCode } from "../src/core/jsonrpc.js";
import { MeshError, ErrorCode } from "../../sdk-typescript/src/types/errors.js";
import type { Manifest } from "../../sdk-typescript/src/types/manifest.js";
import type { TaskState } from "../../sdk-typescript/src/types/task.js";

// ─── §6 Payload ↔ Parts ──────────────────────────────────────────────

describe("partsToInput (BRIDGE-A2A.md §6)", () => {
  it("single DataPart passes through as-is", async () => {
    expect(await partsToInput([{ data: { a: 1 } }])).toEqual({ a: 1 });
  });

  it("TextParts only join into {text}", async () => {
    expect(await partsToInput([{ text: "one" }, { text: "two" }])).toEqual({ text: "one\ntwo" });
  });

  it("mixed: first DataPart with text merged when absent", async () => {
    expect(await partsToInput([{ text: "hi" }, { data: { a: 1 } }])).toEqual({ a: 1, text: "hi" });
  });

  it("mixed: DataPart's own text wins", async () => {
    expect(await partsToInput([{ text: "hi" }, { data: { text: "keep" } }])).toEqual({ text: "keep" });
  });
});

// §7.5 files. The bridge refused every FilePart until the mesh had somewhere to
// put bytes; refusing them now means it cannot carry the most common thing an
// A2A client sends.
describe("files across the bridge (§7.5)", () => {
  const sink: FileSink = {
    async store({ name, mediaType, bytes }) {
      return { name, media_type: mediaType, ref: "mesh:artifacts:AAAAAAAAAAAAAAAAAAAA", size: bytes.byteLength };
    },
  };

  it("passes a uri through WITHOUT fetching it", async () => {
    // A bridge that dereferenced a caller-supplied URL would be an open SSRF
    // proxy inside the mesh's network. The agent decides what to fetch.
    const out = (await partsToInput([{ file: { uri: "https://elsewhere/x.pdf", mimeType: "application/pdf", name: "x.pdf" } }])) as {
      files: unknown[];
    };
    expect(out.files).toEqual([{ name: "x.pdf", media_type: "application/pdf", uri: "https://elsewhere/x.pdf" }]);
  });

  it("stores inline bytes and carries a mesh ref instead", async () => {
    const out = (await partsToInput(
      [{ file: { bytes: Buffer.from("hello").toString("base64"), mimeType: "text/plain", name: "h.txt" } }],
      sink,
    )) as { files: Array<{ ref?: string; size?: number }> };
    expect(out.files[0].ref).toBe("mesh:artifacts:AAAAAAAAAAAAAAAAAAAA");
    expect(out.files[0].size).toBe(5);
  });

  it("refuses bytes when there is nowhere to put them", async () => {
    await expect(partsToInput([{ file: { bytes: "AAAA" } }])).rejects.toBeInstanceOf(FileStoreError);
  });

  it("refuses a file that names neither bytes nor a uri", async () => {
    await expect(partsToInput([{ file: { name: "ghost.pdf" } }], sink)).rejects.toBeInstanceOf(FileStoreError);
  });

  it("keeps every file rather than only the first", async () => {
    const out = (await partsToInput(
      [{ file: { uri: "https://a/1" } }, { file: { uri: "https://a/2" } }],
      sink,
    )) as { files: unknown[] };
    expect(out.files).toHaveLength(2);
  });

  it("carries files alongside text", async () => {
    const out = (await partsToInput([{ text: "look at this" }, { file: { uri: "https://a/1" } }])) as {
      text: string;
      files: unknown[];
    };
    expect(out.text).toBe("look at this");
    expect(out.files).toHaveLength(1);
  });

  it("turns a mesh ref back into a fetchable URL going out", () => {
    expect(refToUrl("mesh:artifacts:AAAAAAAAAAAAAAAAAAAA", "https://api.agentmesh.ai/")).toBe(
      "https://api.agentmesh.ai/artifacts/AAAAAAAAAAAAAAAAAAAA",
    );
  });

  it("hands an A2A party a signed link it asked for with its own identity, never the run-file door (debt 447)", async () => {
    const asked: Array<{ ref: string; opts: unknown }> = [];
    const agent = {
      artifactLink: async (ref: string, opts?: unknown) => {
        asked.push({ ref, opts });
        return { url: "https://storage.test/get/signed?sig=x" };
      },
    };
    const out = await linkFiles({ text: "done", files: [{ ref: "mesh:artifacts:AAAAAAAAAAAAAAAAAAAA", name: "r.pdf", media_type: "application/pdf" }] }, meshLinker(agent));
    const parts = outputToParts(out);
    expect(parts[0]).toEqual({ file: { name: "r.pdf", mimeType: "application/pdf", uri: "https://storage.test/get/signed?sig=x" } });
    expect(asked).toEqual([{ ref: "mesh:artifacts:AAAAAAAAAAAAAAAAAAAA", opts: { download_name: "r.pdf" } }]);
    expect(JSON.stringify(parts)).not.toContain("/artifacts/");
  });

  it("keeps a file it could not link in the payload by its reference, never dropped and never a dead address", async () => {
    const agent = { artifactLink: async () => { throw new Error("no link for a broker-held file"); } };
    const parts = outputToParts(await linkFiles({ files: [{ ref: "mesh:artifacts:AAAAAAAAAAAAAAAAAAAA", name: "r.pdf" }] }, meshLinker(agent)));
    expect(parts).toEqual([{ data: { files: [{ ref: "mesh:artifacts:AAAAAAAAAAAAAAAAAAAA", name: "r.pdf" }] } }]);
  });

  it("drops a ref shape it does not serve rather than inventing a link", () => {
    expect(refToUrl("mesh:rooms:abc/drive/def", "https://api.agentmesh.ai")).toBeNull();
  });

  it("round-trips a file out as a FilePart", () => {
    const parts = outputToParts(
      { text: "here it is", files: [{ ref: "mesh:artifacts:AAAAAAAAAAAAAAAAAAAA", name: "r.pdf", media_type: "application/pdf" }] },
      "https://api.agentmesh.ai",
    );
    expect(parts[0]).toEqual({
      file: { name: "r.pdf", mimeType: "application/pdf", uri: "https://api.agentmesh.ai/artifacts/AAAAAAAAAAAAAAAAAAAA" },
    });
    // Files lead: a sentence that arrives before its attachment reads as a
    // broken promise in every client that renders them in order.
    expect(parts[1]).toEqual({ text: "here it is" });
  });

  it("NEVER silently drops a file it cannot turn into a URL", () => {
    // Shipped once: `files` was lifted out of the payload and then only emitted
    // when a base URL was configured, so a bridge without one delivered a
    // message that looked complete and had lost the attachment. Losing a
    // deliverable must not be the quiet path.
    const parts = outputToParts({ text: "here", files: [{ ref: "mesh:artifacts:AAAAAAAAAAAAAAAAAAAA" }] });
    expect(JSON.stringify(parts)).toContain("mesh:artifacts:AAAAAAAAAAAAAAAAAAAA");
  });

  it("still emits a uri file with no base url configured", () => {
    // A uri needs no base to be fetchable, so it becomes a FilePart regardless.
    expect(outputToParts({ files: [{ uri: "https://a/1" }] })).toEqual([{ file: { uri: "https://a/1" } }]);
  });

  it("emits no empty DataPart when a message was only a file", () => {
    const parts = outputToParts({ files: [{ uri: "https://a/1" }] }, "https://api.agentmesh.ai");
    expect(parts).toEqual([{ file: { uri: "https://a/1" } }]);
  });
});

describe("outputToParts (BRIDGE-A2A.md §6)", () => {
  it("{text} only becomes a TextPart", () => {
    expect(outputToParts({ text: "hello" })).toEqual([{ text: "hello" }]);
  });

  it("structured output becomes a DataPart", () => {
    expect(outputToParts({ text: "hello", extra: 1 })).toEqual([{ data: { text: "hello", extra: 1 } }]);
    expect(outputToParts([1, 2])).toEqual([{ data: [1, 2] }]);
  });

  it("round-trips a DataPart", async () => {
    const input = { query: "q", n: 3 };
    expect(await partsToInput(outputToParts(input) as never)).toEqual(input);
  });
});

// ─── §5 States ───────────────────────────────────────────────────────

describe("state mapping (BRIDGE-A2A.md §5)", () => {
  const all: TaskState[] = [
    "submitted", "working", "input_required", "auth_required",
    "completed", "failed", "canceled", "rejected",
  ];

  it("is total and round-trips", () => {
    for (const s of all) {
      expect(a2aStateToMesh(meshStateToA2A(s))).toBe(s);
    }
  });

  it("maps hyphen spellings", () => {
    expect(meshStateToA2A("input_required")).toBe("input-required");
    expect(a2aStateToMesh("auth-required")).toBe("auth_required");
  });

  it("accepts enum spellings", () => {
    expect(a2aStateToMesh("TASK_STATE_INPUT_REQUIRED")).toBe("input_required");
    expect(a2aStateToMesh("TASK_STATE_COMPLETED")).toBe("completed");
  });

  it("rejects unknown states", () => {
    expect(a2aStateToMesh("running")).toBeUndefined();
  });
});

// ─── §7 Errors ───────────────────────────────────────────────────────

describe("error mapping (BRIDGE-A2A.md §7)", () => {
  it("preserves the mesh code in data.agentmesh_code", () => {
    const mapped = meshErrorToRpc(new MeshError(ErrorCode.OFFERING_NOT_FOUND, "no such offering"));
    expect(mapped.error.code).toBe(RpcCode.INVALID_PARAMS);
    expect(mapped.error.data?.agentmesh_code).toBe("OFFERING_NOT_FOUND");
  });

  it("maps availability to HTTP 502 and timeout to 504", () => {
    expect(meshErrorToRpc(new MeshError(ErrorCode.AGENT_UNAVAILABLE, "x")).httpStatus).toBe(502);
    expect(meshErrorToRpc(new MeshError(ErrorCode.TRANSPORT_TIMEOUT, "x")).httpStatus).toBe(504);
  });

  it("unlisted codes fall back to internal error", () => {
    const mapped = meshErrorToRpc(new MeshError(ErrorCode.CONTEXT_TOO_LARGE, "x"));
    expect(mapped.error.code).toBe(RpcCode.INTERNAL_ERROR);
    expect(mapped.error.data?.agentmesh_code).toBe("CONTEXT_TOO_LARGE");
  });

  it("inverse preserves the A2A code in meta", () => {
    const mesh = rpcErrorToMesh({ code: RpcCode.TASK_NOT_FOUND, message: "gone" });
    expect(mesh.code).toBe(ErrorCode.TASK_NOT_FOUND);
    expect(mesh.meta.a2a_code).toBe(RpcCode.TASK_NOT_FOUND);
  });
});

// ─── §8 Manifest ↔ Card ──────────────────────────────────────────────

const manifest: Manifest = {
  id: "UAGENTPUBKEY",
  name: "Echo",
  description: "Echoes input",
  version: "1.0.0",
  protocol_version: "0.2",
  provider: { name: "AgentMesh" },
  endpoint: "mesh.agent.UAGENTPUBKEY.inbox",
  node: { id: "UNODE", attestation: { node: "UNODE", agent: "UAGENTPUBKEY", issued_at: "", expires_at: "", sig: "" } },
  capabilities: ["echo"],
  offerings: [
    {
      id: "echo",
      name: "Echo",
      description: "Returns input",
      examples: [{ input: { message: "hi" }, output: { echoed: { message: "hi" } } }],
      streaming: true,
    },
  ],
};

describe("manifestToCard (BRIDGE-A2A.md §8.1)", () => {
  const card = manifestToCard(manifest, "https://a2a.agentmesh.ai/");

  it("declares the pinned JSON-RPC and HTTP+JSON interfaces (§3, §13)", () => {
    expect(card.supportedInterfaces).toEqual([
      { url: "https://a2a.agentmesh.ai/agents/UAGENTPUBKEY/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: "https://a2a.agentmesh.ai/agents/UAGENTPUBKEY", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    ]);
  });

  it("carries the bridge extension marker", () => {
    expect(card.capabilities.extensions?.[0].uri).toBe(BRIDGE_EXTENSION_URI);
    expect(card.capabilities.extensions?.[0].params?.direction).toBe("inbound");
  });

  it("declares required capability flags", () => {
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.capabilities.extendedAgentCard).toBe(false);
  });

  it("serializes skill example inputs to strings", () => {
    expect(card.skills[0].examples).toEqual(['{"message":"hi"}']);
  });

  // §8.5 ↔ a2a §8.5. The bridge used to stamp application/json + text/plain on
  // every card it generated, whether or not the agent handled anything else —
  // which made a PDF-accepting agent indistinguishable from a text-only one to
  // every A2A client in the world.
  it("assumes text and JSON only when the agent declared nothing", () => {
    expect(card.defaultInputModes).toEqual(["application/json", "text/plain"]);
  });

  it("publishes the agent's declared modes when it has them", () => {
    const declared = manifestToCard(
      { ...manifest, default_input_modes: ["application/pdf"], default_output_modes: ["text/plain"] },
      "https://a2a.agentmesh.ai/",
    );
    expect(declared.defaultInputModes).toEqual(["application/pdf"]);
    expect(declared.defaultOutputModes).toEqual(["text/plain"]);
  });

  it("falls a modeless skill back to the card default, not to the assumption", () => {
    // An agent that says it takes images and then adds a skill without its own
    // modes means "this one takes images too".
    const declared = manifestToCard(
      { ...manifest, default_input_modes: ["image/png"] },
      "https://a2a.agentmesh.ai/",
    );
    expect(declared.skills[0].inputModes).toEqual(["image/png"]);
  });

  it("lets a skill's own modes win over the card default", () => {
    const declared = manifestToCard(
      {
        ...manifest,
        default_input_modes: ["image/png"],
        offerings: [{ ...manifest.offerings[0], input_modes: ["application/pdf"] }],
      },
      "https://a2a.agentmesh.ai/",
    );
    expect(declared.skills[0].inputModes).toEqual(["application/pdf"]);
  });
});

describe("cardToManifestFields (BRIDGE-A2A.md §8.2)", () => {
  const card = {
    name: "Remote",
    description: "d",
    version: "2.0",
    supportedInterfaces: [
      { url: "https://r.example.com/a2a/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" },
      { url: "https://r.example.com/a2a/v1", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    provider: { organization: "Org", url: "https://org.example.com" },
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      { id: "s1", name: "S1", description: "", tags: ["x", "y"], examples: ["prose example"] },
      { id: "s2", name: "S2", description: "", tags: ["y", "z"] },
    ],
  };

  it("picks the JSONRPC interface", () => {
    expect(jsonRpcInterfaceUrl(card)).toBe("https://r.example.com/a2a/v1");
  });

  const fields = cardToManifestFields(card, "https://r.example.com/a2a/v1", false);

  it("unions tags into capabilities", () => {
    expect(fields.capabilities.sort()).toEqual(["x", "y", "z"]);
  });

  it("carries the remote's declared modes into the mesh manifest", () => {
    // Previously dropped: the outbound direction threw away the one thing the
    // remote card said about what it accepts, so the registered mesh manifest
    // claimed nothing and the storefront could not answer for it either.
    expect(fields.default_input_modes).toEqual(["application/json"]);
    expect(fields.default_output_modes).toEqual(["application/json"]);
  });

  it("drops prose examples rather than guessing", () => {
    expect(fields.offerings[0].examples).toBeUndefined();
  });

  it("marks provenance in extensions and meta", () => {
    expect(fields.extensions[0].uri).toBe(BRIDGE_EXTENSION_URI);
    const marker = fields.meta.a2a_bridge as Record<string, unknown>;
    expect(marker.direction).toBe("outbound");
    expect(marker.endpoint).toBe("https://r.example.com/a2a/v1");
    expect(marker.card_signature_verified).toBe(false);
  });

  it("maps provider organization back to provider name", () => {
    expect(fields.provider).toEqual({ name: "Org", url: "https://org.example.com" });
  });
});
