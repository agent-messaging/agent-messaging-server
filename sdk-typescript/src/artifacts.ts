import type { RefPart } from "./types/envelope.js";
import { MeshError, ErrorCode } from "./types/errors.js";

/**
 * The mesh-wide artifact store (§7.5), client side.
 *
 * An agent that wants to return a file has, until now, had exactly two
 * options: inline it as text in the payload, or say nothing. `RefPart` has
 * existed in the envelope since 0.1 and there was no store to mint a ref
 * against — `mesh_artifacts` was in the spec's storage table and in no code.
 *
 * These are deliberately small: `put` gives you a `RefPart` you can drop
 * straight into an artifact, and `fetch` gives you bytes back with the digest
 * already checked. The check is not optional and not a flag, because a digest a
 * caller has to remember to verify is a digest that does not get verified.
 *
 * ## Large files go by link, and the message carries the pointer
 *
 * A file used to travel base64 inside one NATS message each way, so the
 * broker's message size (§18.9, 1 MB on ours) was the largest file anyone
 * could store or read. Now a file over `ARTIFACT_INLINE_MAX` is sent in three
 * steps: `put.begin` declares it and gets a signed upload link, the bytes go
 * to storage by HTTP PUT, and `put.commit` has the store check them. A large
 * fetch comes back as a signed download link, which is followed here and
 * checked exactly as the inline bytes are. Callers see none of it: the
 * signatures and return shapes are what they were, and small files take the
 * old path unchanged.
 */

/** Well-known artifact-service subjects. */
export const ArtifactSubjects = {
  PUT: "mesh.artifacts.put",
  FETCH: "mesh.artifacts.fetch",
  STAT: "mesh.artifacts.stat",
  REMOVE: "mesh.artifacts.remove",
  USAGE: "mesh.artifacts.usage",
  PUT_BEGIN: "mesh.artifacts.put.begin",
  PUT_COMMIT: "mesh.artifacts.put.commit",
  LINK: "mesh.artifacts.link",
} as const;

/**
 * The largest file that travels inside a message: 512 KiB.
 *
 * Base64 makes 512 KiB into about 683 KiB of text, and the signed envelope
 * around it (ids, trace, signature, the other fields) adds a few KiB more, so
 * the whole message is roughly 690 KiB against a broker that takes 1 MiB. The
 * other 300 KiB or so is headroom for an envelope that grows and for a broker
 * configured a little under the default, since overshooting is not a slower
 * request but a refused one. A round number well inside the limit is also
 * easier to reason about than one computed to the edge of it. Anything bigger
 * goes by signed link and never touches the broker at all.
 */
export const ARTIFACT_INLINE_MAX = 512 * 1024;

export interface PutArtifactOptions {
  /** MIME type of the bytes. Defaults to `application/octet-stream`, which is
   *  honest but unhelpful — pass the real one where you know it, since it is
   *  what tells the far side whether it can read this at all. */
  media_type?: string;
  /** Filename, when these bytes are a file. */
  name?: string;
  /** How long to keep it, in days. Omitted means the mesh's default (§7.5.2:
   *  the task retention window plus a grace period). Clamped to the mesh's
   *  maximum, and the real expiry comes back in the reply — so read it rather
   *  than assuming you got what you asked for. */
  retain_days?: number;
}

/** What the store returns for a stored object: a ready-to-use `RefPart` plus
 *  the expiry, which the caller did not choose and needs to know. */
export interface StoredArtifact extends RefPart {
  digest: string;
  expires_at: string;
}

/** A fetched artifact: its reference fields plus the bytes. Named for the
 *  content rather than the act, because rooms already has a `FetchedArtifact`
 *  and two types with one name in one SDK is a trap for the next reader. */
export interface ArtifactContent extends RefPart {
  digest: string;
  data: Uint8Array;
}

export interface ArtifactUsage {
  bytes: number;
  objects: number;
  max_bytes: number;
  max_objects: number;
}

/** A signed link to one artifact's bytes (`artifactLink`). Anyone holding the
 *  URL can download the file until `expires_at`, so it deserves the same care
 *  as the ref it was made from (§7.5.4). */
export interface ArtifactLink {
  ref: string;
  url: string;
  expires_at: string;
  media_type: string;
  size: number;
  digest: string;
  name?: string;
}

export interface ArtifactLinkOptions {
  /** The file name a browser saves the download under. Defaults to the name
   *  the file was stored with. */
  download_name?: string;
}

/** The capabilities these helpers need from an agent. */
export interface ArtifactHost {
  serviceRequest(subject: string, payload: unknown, timeoutMs?: number): Promise<unknown>;
  /** HTTP for the signed links a large file travels by. Defaults to the global
   *  `fetch`, which Node 22 and every browser have; tests hand in a stub. */
  fetch?: typeof fetch;
}

// Standard base64 with padding, and SHA-256 through SubtleCrypto. Neither
// `Buffer` nor `node:crypto` appears here on purpose: this SDK runs in browsers
// as well as Node, and a `node:` import is the kind of thing that typechecks
// everywhere and then fails at the one runtime you were shipping to.
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `sha256:<64 lowercase hex>` — the §7.5.1 digest format, which is also what
 *  the rooms drive has always used, so one hash means one thing mesh-wide. */
async function sha256(bytes: Uint8Array): Promise<string> {
  // A copy of exactly the view's bytes, never `.buffer`: a Node `Buffer`'s
  // `slice()` is a view, and a small Buffer lives in Node's shared 8 KiB pool,
  // so `buf.slice().buffer` is the whole pool. The copy also keeps SubtleCrypto
  // from refusing a view onto a SharedArrayBuffer.
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  let hex = "";
  for (const b of hash) hex += b.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

/** The HTTP function to use, called as a plain function: a browser's `fetch`
 *  refuses to run with `this` bound to some other object, which is what
 *  `host.fetch(...)` would do. */
const httpOf = (host: ArtifactHost): typeof fetch => host.fetch ?? ((input, init) => fetch(input, init));

/** A deadline for one transfer: two minutes to get going plus a floor of
 *  512 KiB a second, so a gigabyte gets over half an hour and a stalled
 *  connection still ends. `AbortSignal.timeout` is in Node 22 and in every
 *  current browser. */
function transferSignal(size: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(120_000 + Math.ceil(size / (512 * 1024)) * 1000)
    : undefined;
}

/** How long to wait for `put.commit`, which reads the whole object back from
 *  storage and hashes it before answering: thirty seconds plus one for every
 *  4 MiB. */
const commitTimeoutMs = (size: number): number => 30_000 + Math.ceil(size / (4 * 1024 * 1024)) * 1000;

/** What `put.begin` answers: where to send the bytes, and how. */
interface UploadGrant {
  object_id: string;
  ref: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

/** Store bytes and get back a reference you can put in an artifact. */
export async function putArtifact(
  host: ArtifactHost,
  bytes: Uint8Array,
  opts: PutArtifactOptions = {},
): Promise<StoredArtifact> {
  const local = await sha256(bytes);
  const resp = bytes.byteLength > ARTIFACT_INLINE_MAX
    ? await putByLink(host, bytes, local, opts)
    : await putInline(host, bytes, opts);

  // The store computed a digest over what it received; we compute one over what
  // we sent. They disagreeing means the bytes did not survive the trip, and
  // returning a ref whose digest describes different bytes would hand the
  // caller a reference that fails verification for everyone downstream — at a
  // point where nobody can tell whether the file or the reference is wrong.
  if (resp.digest !== local) {
    throw new MeshError(
      ErrorCode.INTERNAL_ERROR,
      `the artifact store hashed what it received to ${resp.digest}, but the bytes sent hash to ${local}`,
    );
  }
  return resp;
}

async function putInline(host: ArtifactHost, bytes: Uint8Array, opts: PutArtifactOptions): Promise<StoredArtifact> {
  return (await host.serviceRequest(ArtifactSubjects.PUT, {
    data_b64: toBase64(bytes),
    media_type: opts.media_type,
    name: opts.name,
    retain_days: opts.retain_days,
  })) as StoredArtifact;
}

/**
 * A large file: declare it, send the bytes to the link the store hands back,
 * then ask the store to check them.
 *
 * Two answers to `put.begin` send the file the old way instead. No responders
 * is a store from before links; a permission refusal is a credential minted
 * before these subjects existed, which lasts until it is renewed. Either way
 * the inline put is what this SDK did yesterday, so a file that fits in a
 * message still gets stored and one that does not fails as it always did,
 * rather than every large write failing for a reason the caller cannot fix.
 */
async function putByLink(
  host: ArtifactHost,
  bytes: Uint8Array,
  digest: string,
  opts: PutArtifactOptions,
): Promise<StoredArtifact> {
  const media_type = opts.media_type?.trim() || "application/octet-stream";
  let grant: UploadGrant;
  try {
    grant = (await host.serviceRequest(ArtifactSubjects.PUT_BEGIN, {
      size: bytes.byteLength,
      digest,
      media_type,
      name: opts.name,
      retain_days: opts.retain_days,
    })) as UploadGrant;
  } catch (err) {
    if (
      err instanceof MeshError &&
      (err.code === ErrorCode.TRANSPORT_NO_RESPONDERS || err.code === ErrorCode.TRANSPORT_PERMISSION_DENIED)
    ) {
      return putInline(host, bytes, opts);
    }
    throw err;
  }

  let status = "no answer";
  try {
    const res = await httpOf(host)(grant.url, {
      method: grant.method ?? "PUT",
      // The headers the store signed, exactly as given: the storage refuses a
      // request whose headers differ from what the link was signed for.
      headers: grant.headers ?? { "content-type": media_type },
      body: bytes as unknown as RequestInit["body"],
      signal: transferSignal(bytes.byteLength),
    });
    status = `HTTP ${res.status}`;
    if (res.ok) {
      return (await host.serviceRequest(
        ArtifactSubjects.PUT_COMMIT,
        { object_id: grant.object_id },
        commitTimeoutMs(bytes.byteLength),
      )) as StoredArtifact;
    }
  } catch (err) {
    if (err instanceof MeshError) throw err;
    status = err instanceof Error ? err.message : String(err);
  }
  // The upload did not land. The pending record would hold this much of the
  // owner's quota until the store's sweep dropped it an hour or two from now,
  // so it is given back straight away. Best effort: the sweep is the backstop.
  await host.serviceRequest(ArtifactSubjects.REMOVE, { ref: grant.ref }).catch(() => undefined);
  throw new MeshError(
    ErrorCode.DEPENDENCY_FAILED,
    `the file could not be sent to the artifact store's upload link (${status}); nothing was stored`,
  );
}

/**
 * Fetch a reference's bytes, verifying the digest.
 *
 * §7.5.1: "a reader that fetches a ref carrying a digest MUST verify it and
 * MUST treat a mismatch as a failed fetch." That is done here rather than left
 * to the caller, so the guarantee holds for every caller instead of the
 * conscientious ones. A large file arrives by signed link rather than inside
 * the reply, and is held to exactly the same checks.
 */
export async function fetchArtifact(host: ArtifactHost, ref: string): Promise<ArtifactContent> {
  // `links: true` tells the store this caller follows a link; a store from
  // before links ignores it and answers inline, as it always has.
  const resp = (await host.serviceRequest(ArtifactSubjects.FETCH, { ref, links: true })) as {
    ref: string;
    media_type: string;
    size: number;
    digest: string;
    name?: string;
    data_b64?: string;
    url?: string;
  };
  let data: Uint8Array;
  if (typeof resp.url === "string" && resp.url) {
    let res: Response;
    try {
      res = await httpOf(host)(resp.url, { signal: transferSignal(resp.size ?? 0) });
    } catch (err) {
      throw new MeshError(
        ErrorCode.DEPENDENCY_FAILED,
        `artifact ${resp.ref} could not be read from its download link: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new MeshError(
        ErrorCode.DEPENDENCY_FAILED,
        `artifact ${resp.ref} could not be read from its download link (HTTP ${res.status})`,
      );
    }
    data = new Uint8Array(await res.arrayBuffer());
  } else {
    data = fromBase64(resp.data_b64 ?? "");
  }
  const local = await sha256(data);
  if (resp.digest && resp.digest !== local) {
    throw new MeshError(
      ErrorCode.INTERNAL_ERROR,
      `artifact ${resp.ref} was announced as ${resp.digest} but the bytes fetched hash to ${local}`,
    );
  }
  if (data.byteLength !== resp.size) {
    throw new MeshError(
      ErrorCode.INTERNAL_ERROR,
      `artifact ${resp.ref} was announced as ${resp.size} bytes but ${data.byteLength} arrived`,
    );
  }
  return {
    ref: resp.ref,
    media_type: resp.media_type,
    size: resp.size,
    digest: resp.digest,
    ...(resp.name ? { name: resp.name } : {}),
    data,
  };
}

/**
 * A signed download link to an artifact, for handing to something that
 * speaks HTTP rather than the mesh: a browser, a person, a tool.
 *
 * Any mesh identity holding the ref may ask (§7.5.4: on the mesh, possession
 * of the reference is the read capability), and the link is that same
 * capability for a short while, in a form a browser can use. Hand it to the
 * one party it is for; a reference is never a public web address (§7.5.4). `expires_at` says how long. A store that cannot
 * make links, or a file kept where none can be made, is refused with a
 * sentence; `fetchArtifact` still reads it.
 */
export async function artifactLink(
  host: ArtifactHost,
  ref: string,
  opts: ArtifactLinkOptions = {},
): Promise<ArtifactLink> {
  return (await host.serviceRequest(ArtifactSubjects.LINK, {
    ref,
    ...(opts.download_name ? { download_name: opts.download_name } : {}),
  })) as ArtifactLink;
}

/** What a reference is, without fetching the bytes. Answers "is this still
 *  here, and how big" — the question worth asking before downloading 8MB. */
export async function statArtifact(
  host: ArtifactHost,
  ref: string,
): Promise<StoredArtifact & { created_at: string; gone: boolean }> {
  return (await host.serviceRequest(ArtifactSubjects.STAT, { ref })) as StoredArtifact & {
    created_at: string;
    gone: boolean;
  };
}

/** Delete an artifact. Only its owner may (§7.5.4): holding a ref lets you
 *  read, and a forwarded reference must not be a delete button. */
export async function removeArtifact(host: ArtifactHost, ref: string): Promise<void> {
  await host.serviceRequest(ArtifactSubjects.REMOVE, { ref });
}

/** How much of the owner's artifact quota is used. */
export async function artifactUsage(host: ArtifactHost): Promise<ArtifactUsage> {
  return (await host.serviceRequest(ArtifactSubjects.USAGE, {})) as ArtifactUsage;
}
