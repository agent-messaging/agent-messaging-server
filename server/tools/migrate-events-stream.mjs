#!/usr/bin/env node
// MESH_EVENTS migration: the one-time cutover off the pre-§18.3 stream layout.
//
// Before this migration the deployment had no MESH_EVENTS: MESH_METERING bound
// `mesh.event.metering.usage` and each durable room's record bound
// `mesh.event.room.<id>.>` directly. nats-server refuses a new stream whose
// subjects overlap an existing stream's (err 10065), so the spec's MESH_EVENTS
// (`mesh.event.>`, SPEC §18.3) cannot exist until every one of those streams
// stops OWNING its slice and starts SOURCING it instead. This tool performs
// that conversion, preserving data via the copy dance:
//
//   create <name>__tmp sourcing <name>   (a full copy, no filter)
//   wait until the copy holds everything
//   delete <name>, recreate <name> subject-less, sourcing [<name>__tmp,
//     MESH_EVENTS with the old subject as filter]
//   wait until the recreated stream absorbed the copy, delete the tmp
//
// then creates MESH_EVENTS from the SAME config the services use
// (src/shared/events-stream.ts, imported below so tool and service cannot
// drift), and verifies the whole layout.
//
// Idempotent and re-runnable: every step re-inspects live state before acting,
// and a run that died mid-dance leaves a __tmp stream carrying the original
// config in its metadata, from which the next run resumes. acl room records
// bind `mesh.aclroom.*` (outside `mesh.event.>`) and are deliberately left
// alone.
//
// Run from a workstation with FULL-PERMISSION credentials, in a maintenance
// window (messages published between the copy and the recreate are lost for
// the affected stream; MESH_EVENTS does not exist yet to catch them):
//
//   node tools/migrate-events-stream.mjs --server nats://host:4222 --creds path/to.creds
//   node tools/migrate-events-stream.mjs --server ... --creds ... --no-preserve
//
// --no-preserve applies to MESH_METERING only: accept the loss of recorded
// meter events and skip its copy dance (delete + recreate empty). Room records
// are ALWAYS preserved; a room's record is its only transcript.

import { connect, credsAuthenticator } from "nats";
import { readFileSync } from "node:fs";
import { register } from "tsx/esm/api";

// The services are TypeScript; the shared MESH_EVENTS config lives there and
// this tool must build the stream from that exact shape. tsx (a services
// devDependency) makes the .ts module importable here.
register();
const { EVENTS_STREAM, EVENTS_SUBJECT, eventsStreamConfig } = await import(
  "../src/shared/events-stream.ts"
);

const METERING = "MESH_METERING";
const TMP_SUFFIX = "__tmp";
// Where a half-finished run parks the original config, so a resume can
// recreate a stream whose original was already deleted.
const META_KEY = "agentmesh.migrate.original_config";
const WAIT_MS = 120_000;
const POLL_MS = 250;

// ── args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opts = { preserve: true };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--server") opts.server = args[++i];
  else if (args[i] === "--creds") opts.creds = args[++i];
  else if (args[i] === "--no-preserve") opts.preserve = false;
  else if (args[i] === "--preserve") opts.preserve = true;
  else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(1);
  }
}
if (!opts.server) {
  console.error(
    "usage: migrate-events-stream.mjs --server <nats-url> [--creds <path>] [--no-preserve]",
  );
  process.exit(1);
}

// ── helpers ─────────────────────────────────────────────────────────────────

const log = (msg) => console.log(`[migrate] ${msg}`);

function die(where, err) {
  console.error(`[migrate] FAILED at: ${where}`);
  if (err) console.error(`[migrate]   ${err instanceof Error ? err.message : err}`);
  console.error(
    "[migrate] nothing was rolled back: every step re-inspects live state, so fix the " +
      "cause and re-run this tool; it resumes from where it stopped.",
  );
  process.exit(1);
}

/** Under `mesh.event.>`? The only subjects this migration is about. */
const underEvents = (s) => s === "mesh.event.>" || s.startsWith("mesh.event.") || s === "mesh.>" || s === ">";

async function listStreams(jsm) {
  const out = [];
  for await (const si of jsm.streams.list()) out.push(si);
  return out;
}

async function info(jsm, name) {
  try {
    return await jsm.streams.info(name);
  } catch {
    return null;
  }
}

async function waitFor(label, cond) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) die(`timeout (${WAIT_MS}ms) waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const msgs = async (jsm, name) => (await info(jsm, name))?.state.messages ?? 0;

/** The original config, minus its subject binding, plus the sourced shape. */
function sourcedConfig(originalConfig, extraSources) {
  const cfg = { ...originalConfig };
  delete cfg.subjects;
  cfg.sources = extraSources;
  // Server-populated echo fields that add() does not take back.
  delete cfg.mirror;
  return cfg;
}

/**
 * The copy dance for one subject-bound stream. Re-runnable: resumes from
 * whichever of its four states the last run left behind.
 */
async function convert(jsm, name) {
  const tmpName = `${name}${TMP_SUFFIX}`;
  let original = await info(jsm, name);
  let tmp = await info(jsm, tmpName);

  // Recover the pre-migration config: from the live original if it still binds
  // subjects, else from the note a previous run left on the tmp stream.
  let originalConfig = null;
  if (original && (original.config.subjects ?? []).length > 0) {
    originalConfig = original.config;
  } else if (tmp?.config.metadata?.[META_KEY]) {
    originalConfig = JSON.parse(tmp.config.metadata[META_KEY]);
  }

  if (original && (original.config.subjects ?? []).length > 0) {
    // State 1/2: original still subject-bound. Copy first.
    if (!tmp) {
      log(`${name}: creating ${tmpName} (full copy via source, no filter)`);
      await jsm.streams.add({
        name: tmpName,
        retention: "limits",
        storage: originalConfig.storage,
        num_replicas: originalConfig.num_replicas,
        sources: [{ name }],
        metadata: { [META_KEY]: JSON.stringify(originalConfig) },
      });
      tmp = await info(jsm, tmpName);
    } else {
      log(`${name}: ${tmpName} already exists, resuming`);
    }
    await waitFor(`${tmpName} to hold all of ${name}'s messages`, async () => {
      return (await msgs(jsm, tmpName)) >= (await msgs(jsm, name));
    });
    log(`${name}: copy complete (${await msgs(jsm, tmpName)} message(s)); deleting the original`);
    await jsm.streams.delete(name);
    original = null;
  }

  if (!original) {
    // State 3: original gone (this run or a dead one). Recreate subject-less.
    if (!originalConfig) die(`${name}: original is gone and no saved config exists to recreate it from`);
    // Cut the tmp's tie to the original name BEFORE recreating it sourcing the
    // tmp: with the tie still configured the server sees original -> tmp ->
    // original and refuses the add with "detected cycle".
    if (tmp && (tmp.config.sources ?? []).length > 0) {
      // Explicit empty list: nats.js merges update configs with the current
      // one, so omitting `sources` would leave the tie in place.
      await jsm.streams.update(tmpName, { ...tmp.config, sources: [] });
      tmp = await info(jsm, tmpName);
    }
    const filters = (originalConfig.subjects ?? []).map((s) => ({
      name: EVENTS_STREAM,
      filter_subject: s,
    }));
    const srcs = tmp ? [{ name: tmpName }, ...filters] : filters;
    log(`${name}: recreating subject-less, sources = [${srcs.map((s) => s.filter_subject ? `${s.name}(${s.filter_subject})` : s.name).join(", ")}]`);
    await jsm.streams.add(sourcedConfig(originalConfig, srcs));
  } else if ((original.config.sources ?? []).length === 0) {
    die(`${name}: exists subject-less but has NO sources, not a shape this migration produces; inspect by hand`);
  } else {
    log(`${name}: already subject-less and sourced`);
  }

  if (tmp) {
    // State 4: absorb the copy, then drop it.
    await waitFor(`${name} to absorb ${tmpName}'s ${await msgs(jsm, tmpName)} message(s)`, async () => {
      return (await msgs(jsm, name)) >= (await msgs(jsm, tmpName));
    });
    // Drop the tmp SOURCE before deleting the tmp STREAM: a source entry
    // pointing at a deleted stream is a permanent retry in the server log.
    const cur = await info(jsm, name);
    const kept = (cur.config.sources ?? []).filter((s) => s.name !== tmpName);
    if (kept.length !== (cur.config.sources ?? []).length) {
      await jsm.streams.update(name, { ...cur.config, sources: kept });
    }
    log(`${name}: copy absorbed (${await msgs(jsm, name)} message(s)); deleting ${tmpName}`);
    await jsm.streams.delete(tmpName);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

const nc = await connect({
  servers: opts.server,
  ...(opts.creds ? { authenticator: credsAuthenticator(readFileSync(opts.creds)) } : {}),
}).catch((err) => die(`connect to ${opts.server}`, err));
const jsm = await nc.jetstreamManager();

try {
  // a. Inventory.
  const streams = await listStreams(jsm);
  const boundRooms = streams
    .filter(
      (si) =>
        si.config.name.startsWith("rooms_") &&
        !si.config.name.endsWith(TMP_SUFFIX) &&
        (si.config.subjects ?? []).some(underEvents),
    )
    .map((si) => si.config.name)
    .sort();
  const meteringInfo = streams.find((si) => si.config.name === METERING);
  const boundMetering = (meteringInfo?.config.subjects ?? []).some(underEvents);
  // Orphaned tmp streams from a dead run whose original was already deleted.
  const orphanTmps = streams
    .map((si) => si.config.name)
    .filter((n) => n.endsWith(TMP_SUFFIX) && !streams.some((si) => si.config.name === n.slice(0, -TMP_SUFFIX.length)))
    .map((n) => n.slice(0, -TMP_SUFFIX.length));

  log(`inventory: ${streams.length} stream(s); subject-bound rooms: ${boundRooms.length ? boundRooms.join(", ") : "none"}; ` +
      `MESH_METERING subject-bound: ${boundMetering}; interrupted conversions to resume: ${orphanTmps.length ? orphanTmps.join(", ") : "none"}`);

  // b. Rooms, always preserved.
  for (const name of [...new Set([...boundRooms, ...orphanTmps.filter((n) => n.startsWith("rooms_"))])]) {
    await convert(jsm, name).catch((err) => die(`converting ${name}`, err));
  }

  // c. MESH_METERING.
  if (boundMetering || orphanTmps.includes(METERING)) {
    if (opts.preserve) {
      await convert(jsm, METERING).catch((err) => die(`converting ${METERING}`, err));
    } else {
      log(`${METERING}: --no-preserve, deleting recorded meter events and recreating empty`);
      const cfg = meteringInfo.config;
      await jsm.streams.delete(METERING).catch((err) => die(`deleting ${METERING}`, err));
      await jsm.streams
        .add(sourcedConfig(cfg, (cfg.subjects ?? []).map((s) => ({ name: EVENTS_STREAM, filter_subject: s }))))
        .catch((err) => die(`recreating ${METERING}`, err));
    }
  } else if (meteringInfo) {
    log(`${METERING}: already subject-less`);
  } else {
    log(`${METERING}: does not exist on this deployment, nothing to convert`);
  }

  // d. MESH_EVENTS, from the services' own config, once nothing overlaps.
  const remaining = (await listStreams(jsm)).filter(
    (si) => si.config.name !== EVENTS_STREAM && (si.config.subjects ?? []).some(underEvents),
  );
  if (remaining.length > 0) {
    die(`creating ${EVENTS_STREAM}: stream(s) still bind ${EVENTS_SUBJECT}: ${remaining.map((si) => si.config.name).join(", ")}`);
  }
  if (await info(jsm, EVENTS_STREAM)) {
    log(`${EVENTS_STREAM}: already exists`);
  } else {
    log(`${EVENTS_STREAM}: creating (${EVENTS_SUBJECT}, interest retention, 24h)`);
    await jsm.streams.add(eventsStreamConfig()).catch((err) => die(`creating ${EVENTS_STREAM}`, err));
  }

  // e. Verify the final layout.
  const finalStreams = await listStreams(jsm);
  const failures = [];
  const events = finalStreams.find((si) => si.config.name === EVENTS_STREAM);
  if (!events) failures.push(`${EVENTS_STREAM} does not exist`);
  else {
    if (events.config.retention !== "interest") failures.push(`${EVENTS_STREAM} retention is ${events.config.retention}, not interest`);
    if (!(events.config.subjects ?? []).includes(EVENTS_SUBJECT)) failures.push(`${EVENTS_STREAM} does not bind ${EVENTS_SUBJECT}`);
  }
  for (const si of finalStreams) {
    const name = si.config.name;
    if (name === EVENTS_STREAM) continue;
    if (name.endsWith(TMP_SUFFIX)) failures.push(`${name} left behind (interrupted copy dance)`);
    if ((si.config.subjects ?? []).some(underEvents)) failures.push(`${name} still binds subjects under ${EVENTS_SUBJECT}`);
    if (name === METERING || (name.startsWith("rooms_") && (si.config.sources ?? []).length > 0)) {
      const sourced = (si.config.sources ?? []).some((s) => s.name === EVENTS_STREAM && s.filter_subject);
      if ((name === METERING || (si.config.subjects ?? []).length === 0) && !sourced) {
        // acl room records legitimately keep subjects (mesh.aclroom.*) and no
        // sources; anything subject-less must source MESH_EVENTS.
        failures.push(`${name} is subject-less but does not source ${EVENTS_STREAM}`);
      }
    }
  }
  if (failures.length > 0) {
    console.error("[migrate] VERIFY FAIL:");
    for (const f of failures) console.error(`[migrate]   - ${f}`);
    process.exit(1);
  }
  log(`VERIFY PASS: ${EVENTS_STREAM} owns ${EVENTS_SUBJECT}; ` +
      `${finalStreams.filter((si) => (si.config.sources ?? []).some((s) => s.name === EVENTS_STREAM)).length} stream(s) source it; no subject overlap remains`);
} finally {
  await nc.close();
}
