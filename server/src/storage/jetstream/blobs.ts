/**
 * Blobs on JetStream: an object store bucket. Moved here from
 * shared/blob-store.ts with the storage layer; the calls and the store's
 * `kind` (which the artifact store reads to tell its own records apart) are
 * unchanged.
 */
import type { JetStreamClient, ObjectStore } from "nats";
import type { BlobStore } from "../blobs.js";

/** NATS JetStream Object Store: self-contained, lives on the same store as
 *  everything else. The default for the public instance — nothing extra to
 *  run. */
class NatsObjectStore implements BlobStore {
  readonly kind: string;
  readonly own = true;
  constructor(private os: ObjectStore, bucket: string) {
    this.kind = `nats-object-store:${bucket}`;
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.os.putBlob({ name: key }, bytes);
  }
  async get(key: string): Promise<Uint8Array | null> {
    return (await this.os.getBlob(key)) ?? null;
  }
  async del(key: string): Promise<void> {
    try {
      await this.os.delete(key);
    } catch {
      /* already gone */
    }
  }
  async delPrefix(): Promise<void> {
    /* per-object deletes in the caller's reclaim loop are sufficient here */
  }
}

/** The object store bucket of this name, made on first use. */
export async function jetStreamObjectStore(js: JetStreamClient, bucket: string): Promise<BlobStore> {
  const os = await js.views.os(bucket);
  return new NatsObjectStore(os, bucket);
}
