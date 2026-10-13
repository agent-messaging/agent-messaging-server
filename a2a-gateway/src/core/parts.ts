/**
 * Payload ↔ Parts mapping (BRIDGE-A2A.md §6). Pure except where a file has to
 * be stored, which is explicitly injected.
 *
 * ## Files
 *
 * The bridge used to refuse every FilePart with a flat "not supported". That
 * was honest while there was nowhere to put bytes — the mesh had no artifact
 * store, so a bridge accepting a file would have had to invent somewhere to
 * keep it. Now that §7.5 exists, refusing files means the bridge cannot carry
 * the single most common thing an A2A client sends.
 *
 * Both directions go through one shape, `MeshFile`, so a file survives a round
 * trip with its name and type intact:
 *
 *   A2A FilePart {file:{bytes}}  →  stored  →  MeshFile {ref, media_type, name}
 *   A2A FilePart {file:{uri}}    →  passed  →  MeshFile {uri, media_type, name}
 *   MeshFile {ref}               →  URL     →  A2A FilePart {file:{uri}}
 *
 * **A uri is passed through, never fetched.** A bridge that dereferenced a
 * caller-supplied URL server-side would be an open SSRF proxy sitting inside
 * the mesh's network, which is a much worse thing to be than a bridge that
 * hands the URL onward and lets the agent decide. The agent knows what it is
 * willing to fetch; the bridge does not.
 */
import {
  type A2APart,
  type A2AFilePart,
  isDataPart,
  isFilePart,
  isTextPart,
} from "./jsonrpc.js";
import { amEnv } from "../am-env.js";

/**
 * A file as it travels on the mesh side of the bridge.
 *
 * Exactly one of `ref` and `uri` is set. `ref` means the bytes are in the mesh
 * artifact store and any mesh agent can fetch them; `uri` means they are
 * somewhere else and whoever wants them decides whether to go there.
 */
export interface MeshFile {
  name?: string;
  media_type?: string;
  /** `mesh:artifacts:…` — bytes the bridge stored (§7.5). */
  ref?: string;
  /** Somewhere else entirely. Passed through unfetched. */
  uri?: string;
  size?: number;
}

/** Where the bridge puts bytes an A2A caller sent. Injected rather than
 *  imported so the mapping stays testable without a mesh connection. */
export interface FileSink {
  store(file: { name?: string; mediaType?: string; bytes: Uint8Array }): Promise<MeshFile>;
}

/** Thrown when a file arrives and this bridge has nowhere to put it — no sink
 *  configured, or the store refused. Distinct from the old blanket refusal:
 *  that one said files are unsupported, which is no longer true, and a caller
 *  told "unsupported" retries with the same file forever. */
export class FileStoreError extends Error {
  constructor(detail: string) {
    super(`this bridge could not store an attached file: ${detail}`);
  }
}

/** Retained for callers that still catch it. The bridge no longer throws this
 *  — files are carried — but removing the export would break an import in a
 *  deployment mid-upgrade for no benefit.
 *  @deprecated files are supported; catch {@link FileStoreError} instead. */
export class FilePartError extends Error {
  constructor() {
    super("FileParts are not supported by this bridge version (BRIDGE-A2A.md §11)");
  }
}

const decodeB64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

/** The A2A `file` object, which is a union in the spec and an untyped bag on
 *  the wire, read defensively. */
function readFile(part: A2AFilePart): { name?: string; mimeType?: string; bytes?: string; uri?: string } {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const top = part as unknown as Record<string, unknown>;
  if (part.file === undefined) {
    // A2A 1.0: the part itself carries `raw` or `url`, `mediaType`, `filename`.
    return {
      name: str(top.filename),
      mimeType: str(top.mediaType),
      bytes: str(top.raw),
      uri: str(top.url),
    };
  }
  const f = (part.file ?? {}) as Record<string, unknown>;
  return {
    name: str(f.name),
    mimeType: str(f.mimeType) ?? str(f.mime_type),
    bytes: str(f.bytes),
    uri: str(f.uri) ?? str(f.url),
  };
}

/**
 * A2A parts → mesh `input` (BRIDGE-A2A.md §6).
 *
 * one DataPart → its object; TextParts only → {text}; mixed → first DataPart
 * with {text} merged in if absent. Files, when present, ride alongside as
 * `files` — an array rather than a single value because A2A permits several
 * and dropping the second one silently is the kind of bug nobody reports.
 */
export async function partsToInput(parts: A2APart[], sink?: FileSink): Promise<unknown> {
  const files = await filesFromParts(parts, sink);

  const dataParts = parts.filter(isDataPart);
  const textParts = parts.filter(isTextPart);
  const joinedText = textParts.map((p) => p.text).join("\n");

  const attach = (base: unknown): unknown => {
    if (!files.length) return base;
    if (typeof base === "object" && base !== null && !Array.isArray(base)) {
      return { ...(base as Record<string, unknown>), files };
    }
    // A non-object payload (an array, a bare value) cannot carry a sibling key
    // without changing its meaning, so the files get their own envelope around
    // it rather than being dropped.
    return { data: base, files };
  };

  if (dataParts.length === 0) {
    return attach({ text: joinedText });
  }

  const first = dataParts[0].data;
  if (textParts.length > 0 && typeof first === "object" && first !== null && !Array.isArray(first)) {
    const obj = first as Record<string, unknown>;
    if (obj.text === undefined) return attach({ ...obj, text: joinedText });
  }
  return attach(first);
}

/** Every FilePart, stored or passed through. Separate so the inbound server can
 *  report a storage failure as its own error rather than a mapping failure. */
export async function filesFromParts(parts: A2APart[], sink?: FileSink): Promise<MeshFile[]> {
  const out: MeshFile[] = [];
  for (const part of parts) {
    if (!isFilePart(part)) continue;
    const f = readFile(part);
    if (f.uri) {
      out.push({
        ...(f.name ? { name: f.name } : {}),
        ...(f.mimeType ? { media_type: f.mimeType } : {}),
        uri: f.uri,
      });
      continue;
    }
    if (!f.bytes) {
      throw new FileStoreError("a file part carried neither bytes nor a uri");
    }
    if (!sink) {
      throw new FileStoreError("this bridge has no artifact store configured");
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeB64(f.bytes);
    } catch {
      throw new FileStoreError("the file's bytes were not valid base64");
    }
    try {
      out.push(await sink.store({ name: f.name, mediaType: f.mimeType, bytes }));
    } catch (err) {
      throw new FileStoreError(err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

/** A mesh artifact reference as an address on the §7.5 HTTPS door. Since
 *  2026-10-07 that door opens a file only for its signed-in owner (AgentMesh
 *  technical debt 447), so an A2A client with no session cannot fetch it:
 *  the bridge hands out a signed link instead ({@link linkFiles}). Kept for
 *  callers that name a file to a person. Returns null for a ref shape this
 *  bridge does not serve. */
export function refToUrl(ref: string, baseUrl: string): string | null {
  const id = /^mesh:artifacts:([A-Za-z0-9_-]{16,128})$/.exec(ref)?.[1];
  return id ? `${baseUrl.replace(/\/+$/, "")}/artifacts/${id}` : null;
}

/**
 * What turns a mesh file reference into an address an A2A party can fetch
 * with no AgentMesh session: a short-lived signed link, asked for by the
 * bridge over the mesh with its own identity (`mesh.artifacts.link`). Null
 * when none can be made, and the file then stays in the payload by its
 * reference rather than being dropped.
 */
export interface FileLinker {
  link(ref: string, name?: string): Promise<string | null>;
}

/** A linker over an agent's own mesh connection. */
export function meshLinker(agent: { artifactLink(ref: string, opts?: { download_name?: string }): Promise<{ url: string }> }): FileLinker {
  return {
    link: async (ref, name) => {
      try {
        const l = await agent.artifactLink(ref, name ? { download_name: name } : {});
        return typeof l?.url === "string" && /^https:\/\//.test(l.url) ? l.url : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Give every file in an output that is only a mesh reference a signed link
 * (`uri`), so {@link outputToParts} can carry it as a FilePart. The link is
 * the file for a short while to whoever holds it, made for this one hand-over;
 * the run-file door itself needs its owner's session (technical debt 447).
 */
export async function linkFiles(output: unknown, linker: FileLinker | null | undefined): Promise<unknown> {
  if (!linker || !output || typeof output !== "object" || Array.isArray(output)) return output;
  const files = (output as { files?: unknown }).files;
  if (!Array.isArray(files)) return output;
  const linked: MeshFile[] = [];
  for (const f of files as MeshFile[]) {
    if (f && !f.uri && typeof f.ref === "string" && refToUrl(f.ref, "x")) {
      const uri = await linker.link(f.ref, f.name);
      linked.push(uri ? { ...f, uri } : f);
    } else linked.push(f);
  }
  return { ...(output as Record<string, unknown>), files: linked };
}

/** One mesh file → an A2A FilePart, or null if there is no way to name where
 *  the bytes are. */
export function fileToPart(file: MeshFile, baseUrl: string): A2AFilePart | null {
  const uri = file.uri ?? (file.ref ? refToUrl(file.ref, baseUrl) : null);
  if (!uri) return null;
  return {
    file: {
      ...(file.name ? { name: file.name } : {}),
      ...(file.media_type ? { mimeType: file.media_type } : {}),
      uri,
    },
  };
}

/**
 * Mesh `output` → A2A parts (BRIDGE-A2A.md §6):
 * exactly {text: string} → one TextPart; anything else → one DataPart. A
 * `files` array, wherever it came from, becomes FileParts alongside — the
 * mirror of `partsToInput`, so a file that came in as a FilePart goes back out
 * as one.
 */
/** Where a mesh artifact reference becomes a fetchable URL for an A2A
 *  file part. One value for the whole gateway, read once. */
export const ARTIFACT_BASE_URL = (process.env.MESH_ARTIFACT_BASE_URL ?? amEnv("urls.api")).replace(/\/+$/, "");

export function outputToParts(output: unknown, baseUrl?: string): A2APart[] {
  if (output === undefined || output === null) return [];
  if (typeof output === "string") return [{ text: output }];

  let rest: unknown = output;
  const fileParts: A2APart[] = [];
  if (typeof output === "object" && !Array.isArray(output) && Array.isArray((output as { files?: unknown }).files)) {
    const { files, ...others } = output as { files: MeshFile[] } & Record<string, unknown>;
    // Anything that cannot be turned into a fetchable URL — a `ref` with no
    // base URL configured, a file naming neither — stays in the payload rather
    // than disappearing.
    //
    // The first cut of this lifted `files` out and then only emitted parts when
    // a base URL was present, so a bridge without one silently dropped every
    // attachment and delivered a message that looked complete. That is the
    // exact failure mode this file's own comments warn about, shipped anyway.
    // Losing a deliverable must never be the quiet path.
    const unresolved: MeshFile[] = [];
    for (const f of files) {
      const part = baseUrl ? fileToPart(f, baseUrl) : f.uri ? fileToPart(f, "") : null;
      if (part) fileParts.push(part);
      else unresolved.push(f);
    }
    rest = unresolved.length ? { ...others, files: unresolved } : others;
  }

  const body = bodyParts(rest);
  // Files first: a client rendering a message shows the attachment beside the
  // sentence about it, and a sentence that arrives before its attachment reads
  // as a broken promise.
  return [...fileParts, ...body];
}

function bodyParts(output: unknown): A2APart[] {
  if (output === undefined || output === null) return [];
  if (typeof output === "string") return [{ text: output }];
  if (
    typeof output === "object" &&
    !Array.isArray(output) &&
    Object.keys(output as object).length === 1 &&
    typeof (output as { text?: unknown }).text === "string"
  ) {
    return [{ text: (output as { text: string }).text }];
  }
  // An object left with nothing in it after the files were lifted out carries
  // no information, and an empty DataPart is noise in every client that draws
  // one.
  if (typeof output === "object" && !Array.isArray(output) && Object.keys(output as object).length === 0) {
    return [];
  }
  return [{ data: output as Record<string, unknown> | unknown[] }];
}
