import { openBlobStore, storageOf, type BlobStore, type StorageLike } from "../storage/index.js";

/**
 * The rooms drive: content-addressed blob storage for room artifacts (CAP-3).
 *
 * This is an OPERATOR concern, invisible on the wire. Members address
 * artifacts by opaque `mesh:rooms:<room_id>/drive/<object-id>` refs and read
 * and write through the rooms service; where the bytes physically live is the
 * operator's choice.
 *
 * The three backends this file used to define live in the storage layer
 * (storage/blobs.ts), because the mesh-wide artifact store (§7.5) needs
 * exactly the same three and there is no version of "two copies of a GCS
 * client" that ends well. The interface below is unchanged apart from its one
 * room-shaped method, so nothing in the rooms service moved.
 */
export interface DriveBackend extends Omit<BlobStore, "delPrefix"> {
  /** Remove everything under a room (called on reclaim/expiry). Backends for
   *  which per-object deletes already suffice MAY leave this a light cleanup. */
  delRoom(roomId: string): Promise<void>;
}

/**
 * Choose the drive backend from the operator's config.
 *   ROOMS_DRIVE_BACKEND = nats  (default: the binding's own store) | fs | gcs
 *   ROOMS_DRIVE_FS_DIR   = <path>       (fs backend; default /opt/agentmesh/rooms-drive)
 *   ROOMS_GCS_BUCKET     = <bucket>     (gcs backend; required)
 */
export async function createDriveBackend(js: StorageLike): Promise<DriveBackend> {
  const store = await openBlobStore(storageOf(js), "rooms_drive", {
    backend: process.env.ROOMS_DRIVE_BACKEND,
    fsDir: process.env.ROOMS_DRIVE_FS_DIR ?? "/opt/agentmesh/rooms-drive",
    gcsBucket: process.env.ROOMS_GCS_BUCKET,
    label: "rooms",
  });
  return {
    kind: store.kind,
    put: (key, bytes) => store.put(key, bytes),
    get: (key) => store.get(key),
    del: (key) => store.del(key),
    delRoom: (roomId) => store.delPrefix(roomId),
  };
}
