import { messagingOf, type MessagingLike } from "../storage/index.js";
import type { BusSubscription, Messaging, StorageLike } from "../storage/index.js";
import { storageOf, type KeyedStore } from "../storage/index.js";
import { createEnvelope, childSpan, decode, ErrorCode, Subjects, ARTIFACT_INLINE_MAX, type Envelope } from "../sdk.js";
import { idOf, sealEnvelope, subscribeWithHandler } from "../shared/handler.js";
import { identityFromEnv } from "../shared/seed.js";
import { serviceQueue } from "../shared/queue-groups.js";
import { ArtifactStore, ARTIFACT_CONFIG, refFor, type ArtifactRecord } from "./artifact-store.js";

/**
 * The artifact service: the front door to the mesh-wide store (§7.5).
 *
 * Every operation is request/reply on a queue group so exactly one instance
 * answers each. A small file rides base64 in the payload, which bounds it to
 * what the broker will carry (§18.9). A large one never touches the broker:
 * `put.begin` hands the writer a signed upload link, `put.commit` checks what
 * arrived, and `fetch` and `link` answer a large read with a signed download
 * link. The message carries the pointer, and the bytes go between the agent
 * and the storage. Only a backend that can sign does this (GCS in production);
 * on the default broker-only backend the three refuse with a sentence and
 * everything else works as it always did. `keep` goes one step further: a
 * holder of a ref gets its own copy, made inside the storage, so a file can
 * change hands with only its pointer on the wire.
 *
 * ## Attribution
 *
 * §7.5.2 requires a write to be attributable to an agent AND an owner, and to
 * be refused otherwise. The agent is `env.from`, which the envelope signature
 * already proves (§4.5) — `subscribeWithHandler` verifies before this code
 * runs. The owner comes from the registry manifest, which is where owner is
 * established (§8.6) and where the registry itself wrote it. A writer that is
 * not registered has no owner and is refused: that is the intended shape, not
 * an edge case, because "who is accountable for these bytes" has no answer for
 * an agent nobody has ever registered.
 */

/** How long an agent→owner resolution is cached. Short, because an agent that
 *  re-registers under a different owner should stop writing to the old one's
 *  quota promptly — but long enough that a burst of writes is one lookup. */
const OWNER_TTL_MS = 60_000;

export const ArtifactSubjects = {
  PUT: "mesh.artifacts.put",
  FETCH: "mesh.artifacts.fetch",
  STAT: "mesh.artifacts.stat",
  REMOVE: "mesh.artifacts.remove",
  USAGE: "mesh.artifacts.usage",
  // Large files, whose bytes go by signed link instead of by message. Every
  // subject here must also be named in cred-template.ts ARTIFACTS_CONTROL, or
  // every credential the platform mints is refused it.
  PUT_BEGIN: "mesh.artifacts.put.begin",
  PUT_COMMIT: "mesh.artifacts.put.commit",
  LINK: "mesh.artifacts.link",
  // A holder of a ref keeps the file under its own owner, copied inside the
  // storage. Same rule: named in ARTIFACTS_CONTROL too.
  KEEP: "mesh.artifacts.keep",
  // The owner holds a file of its own past the sweep while a published page
  // shows it, or releases it (2026-09-25). Named in ARTIFACTS_CONTROL too.
  HOLD: "mesh.artifacts.hold",
} as const;

/** Room left in a message for everything that is not the file: the envelope's
 *  ids, trace, signature and the reply's other fields. Generous, because
 *  being wrong here is a reply the broker drops and a caller that times out. */
const ENVELOPE_ROOM = 16 * 1024;

/** The broker's message size when the connection does not say, which is the
 *  NATS default and what our broker runs (§18.9). */
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;

/** The wire shape of a stored object, the same in every reply that describes
 *  one. `put` and `put.commit` answer exactly this, which is what lets the
 *  SDK return one type whichever way the bytes went. */
function described(r: ArtifactRecord) {
  return {
    ref: refFor(r.id),
    media_type: r.media_type,
    size: r.size,
    digest: r.digest,
    ...(r.name ? { name: r.name } : {}),
  };
}

export class ArtifactsService {
  private readonly kp = identityFromEnv("ARTIFACTS_SEED");
  private subs: BusSubscription[] = [];
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private owners = new Map<string, { at: number; owner: string | null }>();

  private constructor(
    private nc: Messaging,
    private store: ArtifactStore,
    private registry: KeyedStore | null,
  ) {}

  static async create(nc: MessagingLike, js: StorageLike): Promise<ArtifactsService> {
    // The registry's own bucket, read directly for a writer's owner (below).
    // Not fatal without it: the discover door still answers for public agents.
    let registry: KeyedStore | null = null;
    try {
      registry = await storageOf(js).keyed("mesh_registry");
    } catch (err) {
      console.warn("[artifacts] registry bucket not readable; private agents cannot write:", (err as Error).message);
    }
    return new ArtifactsService(messagingOf(nc), await ArtifactStore.create(js), registry);
  }

  async start(): Promise<void> {
    const handlers: Array<[string, (env: Envelope) => Promise<Envelope>]> = [
      [ArtifactSubjects.PUT, (e) => this.handlePut(e)],
      [ArtifactSubjects.FETCH, (e) => this.handleFetch(e)],
      [ArtifactSubjects.STAT, (e) => this.handleStat(e)],
      [ArtifactSubjects.REMOVE, (e) => this.handleRemove(e)],
      [ArtifactSubjects.USAGE, (e) => this.handleUsage(e)],
      [ArtifactSubjects.PUT_BEGIN, (e) => this.handlePutBegin(e)],
      [ArtifactSubjects.PUT_COMMIT, (e) => this.handlePutCommit(e)],
      [ArtifactSubjects.LINK, (e) => this.handleLink(e)],
      [ArtifactSubjects.KEEP, (e) => this.handleKeep(e)],
      [ArtifactSubjects.HOLD, (e) => this.handleHold(e)],
    ];
    for (const [subject, fn] of handlers) {
      this.subs.push(
        subscribeWithHandler(this.nc, subject, this.kp, (env) => fn(env), undefined, undefined, serviceQueue(subject)),
      );
    }
    this.sweepTimer = setInterval(() => {
      this.store.sweep().catch((err) => console.error("[artifacts] sweep error:", err));
    }, ARTIFACT_CONFIG.sweepIntervalMs);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    console.log(
      `[artifacts] service up (${idOf(this.kp).slice(0, 12)}…) · ` +
        `${Math.round(this.store.limits.maxBytes / 1024 / 1024)}MB/artifact, ` +
        `${Math.round(this.store.limits.maxBytesPerOwner / 1024 / 1024)}MB/owner, ` +
        `${this.store.limits.maxObjectsPerOwner} objects/owner, ` +
        `keeps ${Math.round(ARTIFACT_CONFIG.defaultRetentionMs / 86_400_000)}d by default ` +
        `(max ${Math.round(ARTIFACT_CONFIG.maxRetentionMs / 86_400_000)}d)`,
    );
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const s of this.subs) s.unsubscribe();
  }

  // ── replies ─────────────────────────────────────────────────────────────

  private ok(req: Envelope, payload: unknown): Envelope {
    return createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: req.from,
      in_reply_to: req.id,
      trace: childSpan(req.trace),
      payload,
    });
  }

  private err(req: Envelope, code: string, message: string, retryable = false): Envelope {
    return createEnvelope({
      type: "respond",
      from: idOf(this.kp),
      to: req.from,
      in_reply_to: req.id,
      trace: childSpan(req.trace),
      error: { code: code as ErrorCode, message, retryable },
    });
  }

  /** The owner a writing agent counts against (§8.6), from the registry. */
  private async ownerOf(agent: string): Promise<string | null> {
    const hit = this.owners.get(agent);
    if (hit && Date.now() - hit.at < OWNER_TTL_MS) return hit.owner;
    let owner: string | null = null;
    // The registry's record first, read straight from its bucket. The
    // discover door answers "not found" for a PRIVATE agent to any caller it
    // does not know, and this service is not a registered agent, so a
    // private agent could never file a piece: every attachment from an
    // adapter that keeps its listing private was refused as "unregistered"
    // (found 2026-09-22). Recording who is accountable is not disclosing the
    // manifest, so the store reads the owner where the registry keeps it.
    if (this.registry) {
      try {
        const entry = await this.registry.get(agent);
        const manifest = entry?.value.length ? entry.json<{ owner?: string }>() : null;
        if (typeof manifest?.owner === "string" && manifest.owner) {
          this.owners.set(agent, { at: Date.now(), owner: manifest.owner });
          return manifest.owner;
        }
      } catch {
        /* fall through to the discover door */
      }
    }
    try {
      const env = createEnvelope({ type: "discover", from: idOf(this.kp), payload: { agent_id: agent } });
      const resp = await this.nc.request(Subjects.registryGet(agent), sealEnvelope(env, this.kp), { timeout: 3000 });
      const manifest = decode(resp.data).payload as { owner?: string } | undefined;
      owner = typeof manifest?.owner === "string" && manifest.owner ? manifest.owner : null;
    } catch {
      // A registry that did not answer is not proof of no owner, so this is NOT
      // cached as a negative — the next write asks again rather than inheriting
      // a refusal from one timeout.
      return null;
    }
    this.owners.set(agent, { at: Date.now(), owner });
    return owner;
  }

  /** The refusal every write sends when the writer has no owner on record. */
  private unowned(req: Envelope): Envelope {
    return this.err(
      req,
      ErrorCode.UNAUTHORIZED,
      "the artifact store only accepts writes from a registered agent. It records who is " +
        "accountable for every object, and an unregistered agent has no owner to record",
    );
  }

  /** The largest file that can ride inline in a reply on this connection:
   *  base64 is four bytes for every three, less the room the envelope takes. */
  private inlineCeiling(): number {
    const max = (this.nc as { info?: { max_payload?: number } }).info?.max_payload || DEFAULT_MAX_PAYLOAD;
    return Math.max(0, Math.floor(((max - ENVELOPE_ROOM) * 3) / 4));
  }

  // ── handlers ────────────────────────────────────────────────────────────

  private async handlePut(req: Envelope): Promise<Envelope> {
    const p = (req.payload ?? {}) as {
      data_b64?: string;
      media_type?: string;
      name?: string;
      retain_days?: number;
    };
    if (typeof p.data_b64 !== "string" || !p.data_b64) {
      return this.err(req, ErrorCode.INPUT_INVALID, "data_b64 is required");
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(p.data_b64, "base64"));
    } catch {
      return this.err(req, ErrorCode.INPUT_INVALID, "data_b64 is not valid base64");
    }

    const owner = await this.ownerOf(req.from);
    if (!owner) return this.unowned(req);

    const result = await this.store.put({
      owner,
      agent: req.from,
      bytes,
      media_type: p.media_type,
      name: p.name,
      retain_days: p.retain_days,
    });
    if (!result.ok) return this.refused(req, result.code, result.message);
    return this.ok(req, { ...described(result.record), expires_at: result.record.expires_at });
  }

  /** A write refusal, on the wire. NO_LINK is a size refusal as far as the
   *  writer is concerned: this mesh cannot take a file that big, and tidying
   *  up will not change that. */
  private refused(req: Envelope, code: string, message: string): Envelope {
    const wire =
      code === "TOO_LARGE" || code === "NO_LINK"
        ? ErrorCode.PAYLOAD_TOO_LARGE
        : code === "QUOTA_EXCEEDED"
          ? ErrorCode.QUOTA_EXCEEDED
          : ErrorCode.INPUT_INVALID;
    return this.err(req, wire, message);
  }

  /**
   * `put.begin`: declare a large file and get a link to send it to.
   *
   * Carries what `put` carries except the bytes: size, `sha256:<hex>` digest,
   * media type, name, retention. Attribution, the size limit, both quotas and
   * the retention clamp are the store's `put` checks, run before anything is
   * written. The reply is the object id, its ref, and a PUT link with the
   * headers the request must carry; the file is not fetchable until
   * `put.commit` has checked it.
   */
  private async handlePutBegin(req: Envelope): Promise<Envelope> {
    const p = (req.payload ?? {}) as {
      size?: unknown;
      digest?: unknown;
      media_type?: string;
      name?: string;
      retain_days?: number;
    };
    const owner = await this.ownerOf(req.from);
    if (!owner) return this.unowned(req);
    const result = await this.store.begin({
      owner,
      agent: req.from,
      size: p.size,
      digest: p.digest,
      media_type: typeof p.media_type === "string" ? p.media_type : undefined,
      name: typeof p.name === "string" ? p.name : undefined,
      retain_days: p.retain_days,
    });
    if (!result.ok) return this.refused(req, result.code, result.message);
    return this.ok(req, {
      object_id: result.record.id,
      ref: refFor(result.record.id),
      url: result.upload.url,
      method: "PUT",
      headers: result.upload.headers,
      url_expires_at: result.upload.expires_at,
    });
  }

  /**
   * `put.commit`: the bytes have been sent; check them and make the file live.
   *
   * Only the owner that began the upload may commit it. The reply is exactly
   * what `put` answers, so a caller cannot tell which way its file went, and
   * does not need to.
   */
  private async handlePutCommit(req: Envelope): Promise<Envelope> {
    const { object_id } = (req.payload ?? {}) as { object_id?: unknown };
    const owner = await this.ownerOf(req.from);
    if (!owner) return this.unowned(req);
    const result = await this.store.commit(object_id, owner);
    if (result.ok) return this.ok(req, { ...described(result.record), expires_at: result.record.expires_at });
    if (result.code === "NOT_FOUND") return this.err(req, ErrorCode.NOT_FOUND, result.message);
    if (result.code === "FORBIDDEN") return this.err(req, ErrorCode.UNAUTHORIZED, result.message);
    return this.err(req, ErrorCode.INPUT_INVALID, result.message);
  }

  /** GONE and NOT_FOUND are deliberately different answers (§7.5.2): one says
   *  the deliverable expired, the other that it never existed here, and a
   *  reader looking at an old task record needs to tell them apart. */
  private gone(req: Envelope, r: ArtifactRecord): Envelope {
    return this.err(
      req,
      ErrorCode.ARTIFACT_GONE,
      `this artifact expired on ${r.expires_at} and its bytes have been reclaimed. ` +
        `The reference is still accurate about what it was: ${r.size} bytes, ${r.digest}.`,
    );
  }

  /**
   * `fetch`: a file's bytes, or for a large one a link to them.
   *
   * A caller says it can follow a link with `links: true`, which every SDK
   * from 0.51.0 does. Such a caller gets a signed GET in `url` for anything
   * over the inline limit that sits in a backend able to sign. A caller that
   * does not say so is an older SDK that can only read `data_b64`, and it gets
   * the bytes inline whenever they fit in a message, which covers everything
   * that SDK could ever have stored. What does not fit is refused with a
   * sentence rather than attempted, because a reply the broker will not
   * carry reaches the caller as a timeout it cannot explain.
   */
  private async handleFetch(req: Envelope): Promise<Envelope> {
    const { ref, links } = (req.payload ?? {}) as { ref?: unknown; links?: unknown };
    const result = await this.store.fetch(ref, {
      ...(links === true ? { linkOver: ARTIFACT_INLINE_MAX } : {}),
      inlineCeiling: this.inlineCeiling(),
    });
    if (result.ok && "link" in result) {
      return this.ok(req, { ...described(result.record), url: result.link.url, url_expires_at: result.link.expires_at });
    }
    if (result.ok) {
      return this.ok(req, { ...described(result.record), data_b64: Buffer.from(result.bytes).toString("base64") });
    }
    if (result.code === "GONE") return this.gone(req, result.record);
    if (result.code === "TOO_LARGE") {
      return this.err(
        req,
        ErrorCode.PAYLOAD_TOO_LARGE,
        `this file is ${result.record.size} bytes, too big to travel inside a message. It can be read by ` +
          `link: ask with links: true (every SDK from 0.51.0 does), or ask ${ArtifactSubjects.LINK} for one.`,
      );
    }
    return this.err(req, ErrorCode.NOT_FOUND, "no artifact for that reference on this mesh");
  }

  /**
   * `link`: a signed download link for any live artifact whose ref the caller
   * holds. On the mesh, possession of the ref is the read capability
   * (§7.5.4), so there is no owner check, exactly as there is none on
   * `fetch`: the caller is an authenticated mesh identity. The platform's
   * HTTPS doors, which serve people with no mesh identity, do their own
   * checks before they ask (api/artifact-access.ts, technical debt 447). `download_name`, when
   * given, is the file name the browser saves it under. The storage answers
   * with the file's media type; `disposition: "inline"` has it shown in place
   * (a video, a picture, a tab) rather than saved, and anything else, or
   * nothing, is a download as it always was.
   */
  private async handleLink(req: Envelope): Promise<Envelope> {
    const { ref, download_name, disposition } = (req.payload ?? {}) as {
      ref?: unknown;
      download_name?: unknown;
      disposition?: unknown;
    };
    const result = await this.store.link(ref, download_name, { inline: disposition === "inline" });
    if (result.ok) {
      return this.ok(req, { ...described(result.record), url: result.link.url, expires_at: result.link.expires_at });
    }
    if (result.code === "GONE") return this.gone(req, result.record);
    if (result.code === "NO_LINK") {
      return this.err(
        req,
        ErrorCode.INPUT_INVALID,
        "this file is kept where no link can be made (the broker's own store, or a mesh that does not sign " +
          `links). Read it with ${ArtifactSubjects.FETCH} instead; it is small enough to come back inline.`,
      );
    }
    return this.err(req, ErrorCode.NOT_FOUND, "no artifact for that reference on this mesh");
  }

  /**
   * `keep`: keep a file one holds the ref to, under one's own owner.
   *
   * Payload `{ ref, retain_days?, name?, media_type? }`. The caller is a
   * registered agent, like any writer, because the copy is charged to its
   * owner. The ref is the capability, as on `fetch`: the source may belong to
   * anyone. The reply is what `put` answers for the kept copy, plus
   * `kept: true` and `kept_from` (the source ref). When no copy can be made
   * without moving bytes, the reply describes the SOURCE with `kept: false`
   * and `why`, a sentence saying the original ref was kept as it is.
   */
  private async handleKeep(req: Envelope): Promise<Envelope> {
    const p = (req.payload ?? {}) as { ref?: unknown; retain_days?: unknown; name?: unknown; media_type?: unknown };
    const owner = await this.ownerOf(req.from);
    if (!owner) return this.unowned(req);
    const result = await this.store.keep(p.ref, {
      owner,
      agent: req.from,
      retain_days: typeof p.retain_days === "number" ? p.retain_days : undefined,
      name: typeof p.name === "string" ? p.name : undefined,
      media_type: typeof p.media_type === "string" ? p.media_type : undefined,
    });
    if (result.ok && result.copied) {
      return this.ok(req, {
        ...described(result.record),
        expires_at: result.record.expires_at,
        kept: true,
        kept_from: refFor(result.source.id),
      });
    }
    if (result.ok) {
      return this.ok(req, { ...described(result.record), expires_at: result.record.expires_at, kept: false, why: result.why });
    }
    if (result.code === "GONE") return this.gone(req, result.record);
    if (result.code === "NOT_FOUND") return this.err(req, ErrorCode.NOT_FOUND, "no artifact for that reference on this mesh");
    return this.refused(req, result.code, result.message);
  }

  /**
   * `hold`: the owner keeps a file of its own past the sweep, or lets it go.
   *
   * Payload `{ ref, release? }`. Holding is a lease of the store's hold
   * period from now, renewed by asking again; `release: true` ends it and
   * puts the file back on its own expiry, never sooner than the default
   * retention from now. Only the file's owner may do either (a ref is the
   * right to read, and a hold is a charge on the owner's storage). The reply
   * is the ref, its expiry, and `held_until`, null once released.
   */
  private async handleHold(req: Envelope): Promise<Envelope> {
    const p = (req.payload ?? {}) as { ref?: unknown; release?: unknown };
    const owner = await this.ownerOf(req.from);
    if (!owner) return this.err(req, ErrorCode.UNAUTHORIZED, "only a registered agent's owner may hold an artifact");
    const result = await this.store.hold(p.ref, owner, p.release !== true);
    if (result.ok) {
      return this.ok(req, {
        ref: refFor(result.record.id),
        expires_at: result.record.expires_at,
        held_until: result.record.held_until ?? null,
      });
    }
    if (result.code === "GONE") return this.gone(req, result.record);
    if (result.code === "FORBIDDEN") return this.err(req, ErrorCode.UNAUTHORIZED, "that artifact belongs to another owner, so only its owner may hold it");
    return this.err(req, ErrorCode.NOT_FOUND, "no artifact for that reference on this mesh");
  }

  private async handleStat(req: Envelope): Promise<Envelope> {
    const { ref } = (req.payload ?? {}) as { ref?: unknown };
    const record = this.store.stat(ref);
    if (!record) return this.err(req, ErrorCode.NOT_FOUND, "no artifact for that reference on this mesh");
    return this.ok(req, {
      ref: refFor(record.id),
      media_type: record.media_type,
      size: record.size,
      digest: record.digest,
      ...(record.name ? { name: record.name } : {}),
      created_at: record.created_at,
      expires_at: record.expires_at,
      // Present while the owner holds it: the sweep leaves it until then.
      ...(record.held_until ? { held_until: record.held_until } : {}),
      gone: record.gone === true,
    });
  }

  private async handleRemove(req: Envelope): Promise<Envelope> {
    const { ref } = (req.payload ?? {}) as { ref?: unknown };
    const owner = await this.ownerOf(req.from);
    if (!owner) return this.err(req, ErrorCode.UNAUTHORIZED, "only a registered agent's owner may delete an artifact");
    const outcome = await this.store.remove(ref, owner);
    if (outcome === "not_found") return this.err(req, ErrorCode.NOT_FOUND, "no artifact for that reference");
    if (outcome === "forbidden") {
      // Holding a ref lets you READ (§7.5.4). It does not let you destroy
      // somebody else's deliverable, or a forwarded reference would be a
      // delete button handed to everyone it reached.
      return this.err(req, ErrorCode.UNAUTHORIZED, "that artifact belongs to another owner");
    }
    return this.ok(req, { removed: true });
  }

  private async handleUsage(req: Envelope): Promise<Envelope> {
    const owner = await this.ownerOf(req.from);
    if (!owner) return this.err(req, ErrorCode.UNAUTHORIZED, "no owner is recorded for this agent");
    return this.ok(req, this.store.usage(owner));
  }
}
