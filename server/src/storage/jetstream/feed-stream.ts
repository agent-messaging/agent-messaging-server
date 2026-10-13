/**
 * The feed stream (SPEC §6.6a, §18.3): MESH_FEED, owner of `mesh.feed.>`.
 *
 * A feed is the owner-rooted complement to the `mesh.event.>` commons: the
 * subject `mesh.feed.{agent_id}.{topic}` names its one legitimate publisher,
 * and the credential template grants publish on `mesh.feed.<own key>.*` only
 * (keychain/cred-template.ts). This module owns the stream those subjects live in.
 *
 * The §18.3 doctrine from MESH_EVENTS applies unchanged: one subject space,
 * one owner. MESH_FEED is the ONLY stream bound to `mesh.feed.>`; a slice
 * needing its own retention sources from it. Interest retention means a feed
 * published while nothing holds matching interest is not retained — the
 * platform's state-feed writer (registry/feed-state.ts) is a durable consumer
 * over the whole space, so in this deployment every feed publish is captured
 * from the moment that writer first runs.
 *
 * Unlike MESH_EVENTS there is no migration story: `mesh.feed.>` is a new
 * namespace and nothing else has ever bound it, so an overlap refusal here is
 * not a known legacy state — it is loud and unexpected.
 */

import type { JetStreamManager } from "nats";
import { RetentionPolicy, DiscardPolicy, StorageType } from "nats";
import { jsReplicas } from "./kv.js";

export const FEED_STREAM = "MESH_FEED";
/**
 * The stream binds the GRAMMAR — exactly four tokens — never the prefix.
 * `mesh.feed.>` would also capture the three-token lookup subject
 * `mesh.feed.get`, and a captured request with a reply subject gets
 * JetStream's pub-ack sent to that reply, which RACES the responder's real
 * answer and wins: the live probe read `{"stream":"MESH_FEED","seq":N}`
 * where `{found, envelope}` should have been. Binding `mesh.feed.*.*`
 * keeps every legal feed (§6.6a: owner token + single topic token) and
 * nothing else.
 */
export const FEED_SUBJECT = "mesh.feed.*.*";
/** The subject MESH_FEED bound before the grammar fix; healed at ensure. */
const LEGACY_FEED_SUBJECT = "mesh.feed.>";

/**
 * The §18.3 config, built fresh per call because `num_replicas` reads
 * MESH_JS_REPLICAS at creation time (shared/kv.ts). Exported so tools and
 * tests create the stream from THIS shape and cannot drift.
 */
export function feedStreamConfig() {
  return {
    name: FEED_STREAM,
    subjects: [FEED_SUBJECT],
    // Interest, per §18.3: same rationale as MESH_EVENTS — the state-feed
    // writer's durable consumer is the standing interest that makes capture
    // real for the whole space.
    retention: RetentionPolicy.Interest,
    discard: DiscardPolicy.Old,
    storage: StorageType.File,
    max_age: 24 * 60 * 60 * 1_000_000_000, // 24h in ns (§18.3)
    // §18.8 publish dedupe window, carried by the owning stream (§18.3's
    // MESH_FEED row names it explicitly).
    duplicate_window: 2 * 60 * 1_000_000_000, // 2m in ns
    num_replicas: jsReplicas(),
  };
}

/**
 * Create MESH_FEED if it does not exist. Idempotent; returns whether the
 * stream is usable. Fail-soft: feeds are an optional §18.3 stream, and a boot
 * must not die because they are unavailable — but the failure is loud,
 * because unlike a legacy overlap there is no benign reading of it.
 */
export async function ensureFeedStream(jsm: JetStreamManager): Promise<boolean> {
  try {
    try {
      const info = await jsm.streams.info(FEED_STREAM);
      // Heal the legacy prefix binding to the grammar binding (see
      // FEED_SUBJECT). An update, not a delete: the stream keeps what it
      // holds, it just stops capturing the lookup subject.
      const subjects = info.config.subjects ?? [];
      if (subjects.length !== 1 || subjects[0] !== FEED_SUBJECT) {
        if (subjects.includes(LEGACY_FEED_SUBJECT) || subjects.length === 0) {
          await jsm.streams.update(FEED_STREAM, { ...info.config, subjects: [FEED_SUBJECT] });
          console.log(`[feed] stream ${FEED_STREAM} re-bound ${subjects.join(",") || "(none)"} → ${FEED_SUBJECT}`);
        } else {
          console.error(
            `[feed] stream ${FEED_STREAM} binds unexpected subjects (${subjects.join(",")}) — leaving it alone`,
          );
        }
      }
      return true;
    } catch {
      /* not there yet; create below */
    }
    await jsm.streams.add(feedStreamConfig());
    console.log(`[feed] stream ${FEED_STREAM} created (${FEED_SUBJECT}, interest, 24h)`);
    return true;
  } catch (err) {
    console.error(
      `[feed] stream ${FEED_STREAM} unavailable — feeds will not be captured:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
