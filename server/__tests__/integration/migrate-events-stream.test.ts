/**
 * The MESH_EVENTS migration tool, against a REAL local JetStream server.
 *
 * Seeds the pre-migration layout (subject-bound MESH_METERING + a subject-bound
 * room record, each holding messages), runs tools/migrate-events-stream.mjs as
 * a child process the way the orchestrator will, and asserts the data survived
 * the copy dance, MESH_EVENTS exists, live capture flows through the new path,
 * and a second run is a no-op that still passes verification.
 *
 * Needs the checked-in Windows nats-server binary (nats-bin/); when it is
 * missing (CI, another OS) every test skips cleanly rather than failing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type NatsConnection, type JetStreamManager } from "nats";

const SERVICES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_BIN = resolve(
  SERVICES_DIR,
  "../nats-bin/nats-server-v2.10.24-windows-amd64/nats-server.exe",
);
const TOOL = join(SERVICES_DIR, "tools", "migrate-events-stream.mjs");
// Scratch port well away from any real broker (4222) or the WS test port.
const PORT = 42000 + Math.floor(Math.random() * 1000);
const URL = `nats://127.0.0.1:${PORT}`;
const ROOM_STREAM = "rooms_migrtest0123456";
const ROOM_SUBJECT = "mesh.event.room.migrtest0123456.>";
const ROOM_SAY = "mesh.event.room.migrtest0123456.say";

let server: ChildProcess | null = null;
let storeDir: string | null = null;
let nc: NatsConnection | null = null;
let jsm: JetStreamManager | null = null;
let available = false;

/** Run the migration tool exactly as the orchestrator will: a node child. */
function runTool(extra: string[] = []): Promise<{ code: number; out: string }> {
  return new Promise((resolveRun) => {
    const proc = spawn(process.execPath, [TOOL, "--server", URL, ...extra], {
      cwd: SERVICES_DIR,
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("close", (code) => resolveRun({ code: code ?? -1, out }));
  });
}

const poll = async (label: string, cond: () => Promise<boolean>, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

beforeAll(async () => {
  if (!existsSync(SERVER_BIN)) {
    console.warn(`[migrate-it] ${SERVER_BIN} missing, skipping`);
    return;
  }
  storeDir = mkdtempSync(join(tmpdir(), "mesh-events-migrate-"));
  server = spawn(SERVER_BIN, ["-js", "-a", "127.0.0.1", "-p", String(PORT), "-sd", storeDir]);
  // Ready when a connection sticks; the server takes a moment to bind.
  await poll("nats-server to accept connections", async () => {
    try {
      nc = await connect({ servers: URL, timeout: 500, maxReconnectAttempts: 0 });
      return true;
    } catch {
      return false;
    }
  }, 15_000);
  jsm = await nc!.jetstreamManager();

  // The OLD layout, exactly as the live mesh holds it: subject-bound streams
  // owning their slices of mesh.event.>, with data in them.
  await jsm.streams.add({
    name: "MESH_METERING",
    subjects: ["mesh.event.metering.usage"],
    retention: "limits" as never,
    discard: "old" as never,
    storage: "file" as never,
    max_age: 400 * 86_400_000 * 1_000_000,
    num_replicas: 1,
  });
  await jsm.streams.add({
    name: ROOM_STREAM,
    subjects: [ROOM_SUBJECT],
    max_msgs: 10_000,
    max_bytes: 8 * 1024 * 1024,
    discard: "new" as never,
    storage: "file" as never,
    num_replicas: 1,
  });
  const js = nc!.jetstream();
  for (let i = 0; i < 5; i++) {
    await js.publish("mesh.event.metering.usage", JSON.stringify({ seed: i }));
  }
  for (let i = 0; i < 7; i++) {
    await js.publish(ROOM_SAY, JSON.stringify({ say: i }));
  }
  available = true;
}, 30_000);

afterAll(async () => {
  await nc?.close().catch(() => {});
  server?.kill();
  // Give Windows a beat to release file handles before deleting the store.
  if (server) await new Promise((r) => setTimeout(r, 500));
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
});

describe("migrate-events-stream.mjs against a live server", () => {
  it("converts the old layout, preserving every message", async (ctx) => {
    if (!available) return ctx.skip();

    const { code, out } = await runTool();
    expect(out).toContain("VERIFY PASS");
    expect(code).toBe(0);

    // MESH_EVENTS exists, owns the namespace, interest retention.
    const events = await jsm!.streams.info("MESH_EVENTS");
    expect(events.config.subjects).toEqual(["mesh.event.>"]);
    expect(events.config.retention).toBe("interest");

    // Both converted streams are subject-less, sourced, and kept their data.
    const metering = await jsm!.streams.info("MESH_METERING");
    expect(metering.config.subjects ?? []).toEqual([]);
    expect(metering.config.sources).toEqual([
      expect.objectContaining({ name: "MESH_EVENTS", filter_subject: "mesh.event.metering.usage" }),
    ]);
    expect(metering.state.messages).toBe(5);
    // The 400d limit survived the recreate.
    expect(metering.config.max_age).toBe(400 * 86_400_000 * 1_000_000);

    const room = await jsm!.streams.info(ROOM_STREAM);
    expect(room.config.subjects ?? []).toEqual([]);
    expect(room.config.sources).toEqual([
      expect.objectContaining({ name: "MESH_EVENTS", filter_subject: ROOM_SUBJECT }),
    ]);
    expect(room.state.messages).toBe(7);
    expect(room.config.max_msgs).toBe(10_000);

    // No half-finished copy left behind.
    await expect(jsm!.streams.info(`${ROOM_STREAM}__tmp`)).rejects.toThrow();
    await expect(jsm!.streams.info("MESH_METERING__tmp")).rejects.toThrow();
  }, 60_000);

  it("live capture flows through MESH_EVENTS into the sourced streams", async (ctx) => {
    if (!available) return ctx.skip();

    // A post-migration publish must land in the sourced streams via
    // MESH_EVENTS; this is the property the whole cutover rides on. The
    // server connects a stream's source a couple of seconds after the origin
    // appears, and a publish BEFORE that is dropped by interest retention
    // (no interest yet), the loss window the migration's maintenance window
    // exists for. So: publish until one is captured, then require capture to
    // be reliable (the very next publish lands too).
    const js = nc!.jetstream();
    await poll("the room record to capture via MESH_EVENTS", async () => {
      await js.publish(ROOM_SAY, JSON.stringify({ say: "after" }));
      await new Promise((r) => setTimeout(r, 300));
      return (await jsm!.streams.info(ROOM_STREAM)).state.messages > 7;
    }, 20_000);

    const roomBefore = (await jsm!.streams.info(ROOM_STREAM)).state.messages;
    const meterBefore = (await jsm!.streams.info("MESH_METERING")).state.messages;
    await js.publish(ROOM_SAY, JSON.stringify({ say: "settled" }));
    await js.publish("mesh.event.metering.usage", JSON.stringify({ seed: "after" }));
    await poll("both sourced streams to absorb one more message", async () => {
      return (
        (await jsm!.streams.info(ROOM_STREAM)).state.messages === roomBefore + 1 &&
        (await jsm!.streams.info("MESH_METERING")).state.messages === meterBefore + 1
      );
    }, 10_000);
  }, 40_000);

  it("is re-runnable: a second run changes nothing and still passes", async (ctx) => {
    if (!available) return ctx.skip();

    const roomBefore = (await jsm!.streams.info(ROOM_STREAM)).state.messages;
    const meterBefore = (await jsm!.streams.info("MESH_METERING")).state.messages;
    const { code, out } = await runTool();
    expect(out).toContain("VERIFY PASS");
    expect(code).toBe(0);
    expect((await jsm!.streams.info(ROOM_STREAM)).state.messages).toBe(roomBefore);
    expect((await jsm!.streams.info("MESH_METERING")).state.messages).toBe(meterBefore);
  }, 60_000);
});
