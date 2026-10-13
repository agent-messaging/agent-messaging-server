import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BlobStoreName } from "./catalog.js";
import type { Storage as MeshStorage } from "./types.js";

/**
 * Blobs, the storage layer's third kind of store: byte storage behind a
 * four-method interface (put, get and delete by reference, and delete under a
 * prefix), with three interchangeable backends: the binding's own store (on
 * JetStream an object store, storage/jetstream/blobs.ts), a folder on disk,
 * and Google Cloud Storage. Moved here from shared/blob-store.ts with the
 * storage layer (docs/agent-messaging-server-plan.md, step 8).
 *
 * This is the rooms drive, generalized. The rooms drive got the design right
 * and got it right for a reason worth keeping: members address artifacts by an
 * opaque ref and read and write through a service, so where the bytes
 * physically live is the OPERATOR's choice and nothing about the protocol, the
 * SDK or the adapter changes when they swap one backend for another. SPEC
 * §7.5.1 now says that explicitly for every artifact reference, not just a
 * room's.
 *
 * What generalizing cost: `delRoom(roomId)` became `delPrefix(prefix)`, since
 * the artifact store groups by owner rather than by room. Everything else is
 * the same four methods, and rooms/drive.ts is now a thin alias over this so
 * its call sites did not have to move.
 *
 * A backend never needs to understand privacy grades. It is handed whatever
 * bytes it should store — plaintext for an ordinary artifact, ciphertext when
 * the writer sealed it first (§7.5.4) — and it stores and returns bytes by key.
 *
 * ## Links, which only some backends can make
 *
 * Every method above moves bytes through this process, and for the artifact
 * store that means through the broker too: the request that carries them is a
 * NATS message, and the live broker refuses anything over 1 MB (§18.9). A
 * 3.6 MB video was dropped at delivery for exactly that reason on 2026-09-23.
 *
 * So a backend that can sign may also hand out a URL good for one request on
 * one key, and the bytes then go between the agent and the storage directly.
 * The three signing methods are optional on purpose. The nats and filesystem
 * backends have nothing a stranger could be sent to, so they simply do not
 * offer them, and a caller asks `canLink(store)` rather than knowing which
 * backend it was given. That is also what lets a test stand in a fake that
 * signs without a cloud.
 *
 * `copy` is optional for the same reason. It lets the artifact store keep a
 * file for a second owner by copying it inside the storage (GCS rewrites the
 * object itself), so a pointer is all that travels. The broker's object store
 * has no such thing, and a caller asks `canCopy(store)`.
 */
export interface BlobStore {
  /** Human name for logs. */
  readonly kind: string;
  /** True for the binding's own store (on JetStream an object store). The
   *  artifact index records which backend holds a file only when it is not
   *  this one. */
  readonly own?: boolean;
  /** Store bytes under `key`, overwriting. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Fetch bytes, or null if absent. */
  get(key: string): Promise<Uint8Array | null>;
  /** Remove one object; a no-op if already gone. */
  del(key: string): Promise<void>;
  /** Remove everything under a key prefix. Backends for which per-object
   *  deletes already suffice MAY leave this a light cleanup. */
  delPrefix(prefix: string): Promise<void>;
  /** OPTIONAL. A URL that lets whoever holds it PUT exactly `size` bytes of
   *  type `contentType` under `key`, and nothing else, until it expires. */
  signedUploadUrl?(key: string, opts: { contentType: string; size: number; expiresInMs: number }): Promise<SignedLink>;
  /** OPTIONAL. A URL that lets whoever holds it GET `key` until it expires.
   *  The response is served as `contentType` when one is given, and under
   *  `filename` as a download, or shown in place when `inline` is set. */
  signedDownloadUrl?(key: string, opts: DownloadLinkOptions): Promise<SignedLink>;
  /** OPTIONAL. Copy what is stored under `from` to `to` inside the store,
   *  without the bytes passing through this process. False when nothing is
   *  stored under `from`. A backend without it cannot keep a second copy of a
   *  file cheaply, and a caller falls back to something that needs no copy. */
  copy?(from: string, to: string): Promise<boolean>;
  /** OPTIONAL. The size and `sha256:<hex>` of what is stored under `key`,
   *  read as a stream, or null if nothing is. A backend without it is measured
   *  by `get`, which is fine for a small object and is why a backend holding
   *  large ones should offer this: a 1 GiB upload must not be checked by
   *  loading it into the service's memory. */
  measure?(key: string): Promise<{ size: number; digest: string } | null>;
}

/** One signed request's worth of access to one object. `headers` are the ones
 *  the request must carry exactly as given, because they are part of what was
 *  signed; a request that leaves one out or changes it is refused by the
 *  storage, not by us. */
export interface SignedLink {
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}

/** How a download link's response is to be served. The caller has already
 *  made `filename` and `contentType` safe for a response header. */
export interface DownloadLinkOptions {
  expiresInMs: number;
  filename?: string;
  /** The Content-Type the storage answers with, whatever the object says. */
  contentType?: string;
  /** Shown in place (a video, a picture, a page opened in a new tab) rather
   *  than saved. Only ever on the storage's own origin, which is why it is
   *  safe: the link never makes an agent's bytes a page on ours. */
  inline?: boolean;
}

/** Whether a backend can copy one of its objects to another key by itself. */
export function canCopy(store: BlobStore): store is BlobStore & Required<Pick<BlobStore, "copy">> {
  return typeof store.copy === "function";
}

/** Whether a backend can hand out links, asked by capability rather than by
 *  name so a new signing backend needs no change anywhere else. */
export function canLink(
  store: BlobStore,
): store is BlobStore & Required<Pick<BlobStore, "signedUploadUrl" | "signedDownloadUrl">> {
  return typeof store.signedUploadUrl === "function" && typeof store.signedDownloadUrl === "function";
}

/** Size and digest of a stored object, by the backend's stream when it has
 *  one and by reading it whole when it does not. */
export async function measureBlob(store: BlobStore, key: string): Promise<{ size: number; digest: string } | null> {
  if (typeof store.measure === "function") return store.measure(key);
  const bytes = await store.get(key);
  if (!bytes) return null;
  return { size: bytes.byteLength, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
}

/** Local filesystem: one file per object. Useful on a host with a persistent
 *  disk, and the second reference backend that proves the interface is not
 *  NATS-specific. */
class FilesystemStore implements BlobStore {
  readonly kind: string;
  constructor(
    private root: string,
    /** Set when the folder is the binding's own store (on RabbitMQ). */
    readonly own?: boolean,
  ) {
    this.kind = `filesystem:${root}`;
  }

  /** Resolve `key` under root, refusing anything that escapes it. Keys are
   *  server-generated, so traversal is already impossible; this is defense in
   *  depth, and it is the reason a key from the wire can never become a path. */
  private pathFor(key: string): string {
    const full = resolve(this.root, key);
    const base = resolve(this.root);
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error(`blob key escapes the root: ${key}`);
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
  async del(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
  async delPrefix(prefix: string): Promise<void> {
    await rm(this.pathFor(prefix), { recursive: true, force: true });
  }
  async copy(from: string, to: string): Promise<boolean> {
    const dest = this.pathFor(to);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await copyFile(this.pathFor(from), dest);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}

/**
 * Google Cloud Storage: durable object storage OFF the mesh VM, so the store
 * is not bounded by the server's local disk. Auth is Application Default
 * Credentials, and it needs objectAdmin on the bucket.
 *
 * ## Signing, and the one grant it needs
 *
 * This is the backend that can make links (V4 signed URLs,
 * `file.getSignedUrl`). A signature is made with a service account's private
 * key, and where that key lives decides what the operator has to grant:
 *
 *  - On our instance, GOOGLE_APPLICATION_CREDENTIALS names a service-account
 *    KEY FILE (ecosystem.config.cjs; carried because the VM's access scopes do
 *    not include storage). The library signs locally
 *    with the key in that file. No IAM call is made and no extra role is
 *    needed; the account only needs `roles/storage.objectAdmin` on the bucket
 *    (for the artifact store, ARTIFACTS_GCS_BUCKET; ours is named in
 *    ecosystem.config.cjs and docs/our-instance.md, not in code that ships).
 *  - With no key file (ambient credentials from the GCE metadata server), the
 *    library asks IAM to sign through `signBlob`. That needs the account to
 *    hold `roles/iam.serviceAccountTokenCreator` ON ITSELF, the IAM
 *    Credentials API enabled, and a token scope that reaches it. Our VM's
 *    scopes do not, which is one more reason the key file stays.
 *
 * The bucket also needs a CORS rule when a browser is on either end of a link:
 * the account pages fetch a file through a redirect to one, and the SDK in a
 * browser PUTs to one. GET, HEAD and PUT from any origin, exposing
 * Content-Type, Content-Disposition and Content-Length, and allowing the
 * upload's two signed headers. The link is the capability, so `*` gives away
 * nothing a holder of the link does not already have.
 *
 * Exported for the tests, which hand it a bucket of their own; everything
 * else gets one from `createBlobStore`.
 */
export class GcsStore implements BlobStore {
  readonly kind: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private bucket: any, bucketName: string) {
    this.kind = `gcs:${bucketName}`;
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.file(key).save(Buffer.from(bytes), { resumable: false });
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      const [buf] = await this.bucket.file(key).download();
      return new Uint8Array(buf);
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }
  async del(key: string): Promise<void> {
    await this.bucket.file(key).delete({ ignoreNotFound: true });
  }
  async delPrefix(prefix: string): Promise<void> {
    await this.bucket.deleteFiles({ prefix: `${prefix}/`, force: true });
  }

  async signedUploadUrl(key: string, opts: { contentType: string; size: number; expiresInMs: number }): Promise<SignedLink> {
    const expires = Date.now() + opts.expiresInMs;
    // The length range is signed as well as the type, so the link takes this
    // many bytes and no other number. Without it a link good for 1 KB would
    // take a terabyte for fifteen minutes, and the commit check would only
    // find out afterwards, on our storage bill.
    const extensionHeaders = { "x-goog-content-length-range": `${opts.size},${opts.size}` };
    const [url] = await this.bucket.file(key).getSignedUrl({
      version: "v4",
      action: "write",
      expires,
      contentType: opts.contentType,
      extensionHeaders,
    });
    return {
      url,
      headers: { "content-type": opts.contentType, ...extensionHeaders },
      expires_at: new Date(expires).toISOString(),
    };
  }

  async signedDownloadUrl(key: string, opts: DownloadLinkOptions): Promise<SignedLink> {
    const expires = Date.now() + opts.expiresInMs;
    // A download unless the caller asks to show it in place. Showing it is
    // safe here and nowhere else: these are bytes an agent made, with a media
    // type the agent chose, and this link is on the storage's origin, so the
    // worst they can be is a page on storage.googleapis.com, never one on
    // ours. The caller has already made the name and the type safe for a
    // header; both are signed into the link, so the storage answers with them
    // whatever the object's own metadata says.
    const how = opts.inline ? "inline" : "attachment";
    const disposition = opts.filename ? `${how}; filename="${opts.filename}"` : opts.inline ? "inline" : undefined;
    const [url] = await this.bucket.file(key).getSignedUrl({
      version: "v4",
      action: "read",
      expires,
      ...(opts.contentType ? { responseType: opts.contentType } : {}),
      ...(disposition ? { responseDisposition: disposition } : {}),
    });
    return { url, headers: {}, expires_at: new Date(expires).toISOString() };
  }

  /** A copy inside the bucket: GCS rewrites the object itself and the library
   *  follows the rewrite token for a large one, so no byte comes down to this
   *  process. The object's metadata, its content type included, comes along. */
  async copy(from: string, to: string): Promise<boolean> {
    try {
      await this.bucket.file(from).copy(this.bucket.file(to));
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 404) return false;
      throw err;
    }
  }

  async measure(key: string): Promise<{ size: number; digest: string } | null> {
    const hash = createHash("sha256");
    let size = 0;
    try {
      await new Promise<void>((done, fail) => {
        this.bucket
          .file(key)
          .createReadStream()
          .on("data", (chunk: Buffer) => {
            hash.update(chunk);
            size += chunk.length;
          })
          .on("error", fail)
          .on("end", () => done());
      });
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
    return { size, digest: "sha256:" + hash.digest("hex") };
  }
}

/** How an operator picks a backend for one store. */
export interface BlobBackendConfig {
  /** `nats` (default: the binding's own store; on JetStream an object store) | `fs` | `gcs`. */
  backend?: string;
  /** Directory root, for the `fs` backend. */
  fsDir: string;
  /** GCS bucket name, required when `backend` is `gcs`. */
  gcsBucket?: string;
  /** Prefix for log lines, e.g. `rooms` or `artifacts`. */
  label: string;
}

/** The same, naming the object store bucket for the `nats` backend: the shape
 *  the platform's stores pass to `createBlobStore` (shared/blob-store.ts). */
export interface BlobStoreConfig extends BlobBackendConfig {
  /** Object-store bucket name, for the `nats` backend. */
  natsBucket: string;
}

/**
 * Open a core blob store by its name in the layer (storage/catalog.ts), on the
 * backend the operator asked for: a folder, Google Cloud Storage, or by
 * default the binding's own store.
 */
export function openBlobStore(storage: MeshStorage, name: BlobStoreName, config: BlobBackendConfig): Promise<BlobStore> {
  return selectBlobStore(config, () => storage.blobs(name));
}

/**
 * Build the backend an operator asked for; `own` opens the binding's own
 * store, for the default.
 *
 * Adding a backend (S3, Azure, …) is a new branch here plus a class above and
 * nothing anywhere else — which is the whole point of the ref being opaque on
 * the wire (§7.5.1).
 */
export async function selectBlobStore(
  config: BlobBackendConfig,
  own: () => Promise<BlobStore>,
): Promise<BlobStore> {
  const backend = (config.backend ?? "nats").toLowerCase();
  if (backend === "fs" || backend === "filesystem") {
    await mkdir(config.fsDir, { recursive: true });
    return new FilesystemStore(config.fsDir);
  }
  if (backend === "gcs" || backend === "google-cloud-storage") {
    if (!config.gcsBucket) {
      throw new Error(`[${config.label}] backend=gcs requires a bucket name`);
    }
    const { Storage } = await import("@google-cloud/storage");
    const bucket = new Storage().bucket(config.gcsBucket);
    return new GcsStore(bucket, config.gcsBucket);
  }
  if (backend !== "nats" && backend !== "nats-object-store") {
    console.warn(`[${config.label}] unknown backend "${backend}"; using nats`);
  }
  return own();
}

/** A folder as a binding's own blob store: on RabbitMQ, which has no object
 *  store, blobs stay on disk unless the operator picks Google Cloud Storage. */
export async function ownFolderStore(root: string): Promise<BlobStore> {
  await mkdir(root, { recursive: true });
  return new FilesystemStore(root, true);
}

/** Join a store key from its parts. Kept here so every caller spells a key the
 *  same way and the `/` separator is stated once. */
export const blobKey = (...parts: string[]): string => parts.join("/");

export { join as joinPath };
