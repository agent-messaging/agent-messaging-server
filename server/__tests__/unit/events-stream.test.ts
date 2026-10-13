// MESH_EVENTS (SPEC §18.3) and the sourced streams that hang off it.
//
// The stream families that used to bind slices of `mesh.event.>` directly
// (MESH_METERING, rooms_*) now SOURCE those slices from MESH_EVENTS, because
// nats-server refuses overlapping subject-bound streams (err 10065). These
// tests pin the two ensure paths: the owning stream's config and its fail-soft
// refusal handling, and the metering stream's sourced shape plus the
// transition detection that keeps a boot from auto-migrating.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EVENTS_STREAM,
  EVENTS_SUBJECT,
  EVENTS_MIGRATION_TOOL,
  eventsStreamConfig,
  ensureEventsStream,
  isOverlapError,
} from "../../src/shared/events-stream.js";
import { METERING_STREAM, METERING_SUBJECT } from "../../src/shared/metering.js";
import { ensureMeteringStream } from "../../src/storage/jetstream/metering-stream.js";
import { REPLICAS_ENV } from "../../src/storage/jetstream/kv.js";

afterEach(() => {
  delete process.env[REPLICAS_ENV];
  vi.restoreAllMocks();
});

/** The server's overlap refusal, as nats.js surfaces it. */
function overlapError() {
  const err = new Error("subjects overlap with an existing stream") as Error & {
    api_error?: { err_code: number };
  };
  err.api_error = { err_code: 10065 };
  return err;
}

function fakeJsm(behavior: {
  info?: (name: string) => unknown | Promise<unknown>;
  add?: (cfg: unknown) => unknown | Promise<unknown>;
}) {
  const streams = {
    info: vi.fn(async (name: string) => {
      if (behavior.info) return behavior.info(name);
      throw new Error("stream not found");
    }),
    add: vi.fn(async (cfg: unknown) => {
      if (behavior.add) return behavior.add(cfg);
      return {};
    }),
  };
  return { streams };
}

describe("eventsStreamConfig", () => {
  it("is the §18.3 shape: mesh.event.>, interest, 24h, 2m dedupe window", () => {
    const cfg = eventsStreamConfig();
    expect(cfg.name).toBe(EVENTS_STREAM);
    expect(cfg.subjects).toEqual([EVENTS_SUBJECT]);
    expect(cfg.retention).toBe("interest");
    expect(cfg.discard).toBe("old");
    expect(cfg.storage).toBe("file");
    expect(cfg.max_age).toBe(24 * 60 * 60 * 1_000_000_000);
    expect(cfg.duplicate_window).toBe(2 * 60 * 1_000_000_000);
    expect(cfg.num_replicas).toBe(1);
  });

  it("threads MESH_JS_REPLICAS through like every other creation site", () => {
    process.env[REPLICAS_ENV] = "3";
    expect(eventsStreamConfig().num_replicas).toBe(3);
  });
});

describe("ensureEventsStream", () => {
  it("is idempotent: an existing stream means no add call", async () => {
    const jsm = fakeJsm({ info: () => ({ config: { name: EVENTS_STREAM } }) });
    expect(await ensureEventsStream(jsm as never)).toBe(true);
    expect(jsm.streams.add).not.toHaveBeenCalled();
  });

  it("creates the stream from the shared config when missing", async () => {
    const jsm = fakeJsm({});
    expect(await ensureEventsStream(jsm as never)).toBe(true);
    expect(jsm.streams.add).toHaveBeenCalledTimes(1);
    expect(jsm.streams.add.mock.calls[0][0]).toEqual(eventsStreamConfig());
  });

  it("fails SOFT and LOUD on the overlap refusal, naming the migration tool", async () => {
    // err 10065 means the deployment predates the migration: subject-bound
    // MESH_METERING / rooms_* still own slices of mesh.event.>. The boot must
    // carry on (the old streams still capture) but the operator must be told
    // exactly what to run.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const jsm = fakeJsm({ add: () => Promise.reject(overlapError()) });
    expect(await ensureEventsStream(jsm as never)).toBe(false);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("10065"));
    expect(err).toHaveBeenCalledWith(expect.stringContaining(EVENTS_MIGRATION_TOOL));
  });

  it("fails soft on any other creation error too, without the migration hint", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const jsm = fakeJsm({ add: () => Promise.reject(new Error("insufficient storage")) });
    expect(await ensureEventsStream(jsm as never)).toBe(false);
    const logged = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain(EVENTS_MIGRATION_TOOL);
    expect(logged).toContain("insufficient storage");
  });
});

describe("isOverlapError", () => {
  it("matches the err_code and the bare message, nothing else", () => {
    expect(isOverlapError(overlapError())).toBe(true);
    expect(isOverlapError(new Error("subjects overlap with an existing stream"))).toBe(true);
    expect(isOverlapError(new Error("stream not found"))).toBe(false);
    expect(isOverlapError(null)).toBe(false);
  });
});

describe("ensureMeteringStream (sourced shape)", () => {
  it("ensures MESH_EVENTS first, then creates MESH_METERING subject-less sourcing it", async () => {
    const added: unknown[] = [];
    const jsm = fakeJsm({ add: (cfg) => { added.push(cfg); return {}; } });
    expect(await ensureMeteringStream(jsm as never)).toBe(true);
    // Order is the invariant: a sourced stream without its source captures
    // nothing, so MESH_EVENTS must be created before MESH_METERING.
    const names = added.map((c) => (c as { name: string }).name);
    expect(names).toEqual([EVENTS_STREAM, METERING_STREAM]);
    const metering = added[1] as { subjects?: string[]; sources?: unknown };
    expect(metering.subjects).toBeUndefined();
    expect(metering.sources).toEqual([{ name: EVENTS_STREAM, filter_subject: METERING_SUBJECT }]);
  });

  it("detects a pre-migration subject-bound MESH_METERING: loud log, no auto-migration", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const jsm = fakeJsm({
      info: (name: string) => {
        // MESH_EVENTS does not exist; the old stream still binds the subject.
        if (name === METERING_STREAM) return { config: { name, subjects: [METERING_SUBJECT] } };
        throw new Error("stream not found");
      },
      // Overlap refusal for the MESH_EVENTS add; nothing else is added.
      add: (cfg) => {
        if ((cfg as { name: string }).name === EVENTS_STREAM) return Promise.reject(overlapError());
        throw new Error(`unexpected add: ${(cfg as { name: string }).name}`);
      },
    });
    // Still usable: the subject-bound stream captures exactly as it always
    // did, so the fold keeps working while the operator schedules the tool.
    expect(await ensureMeteringStream(jsm as never)).toBe(true);
    const logged = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("SUBJECT-BOUND");
    expect(logged).toContain(EVENTS_MIGRATION_TOOL);
  });

  it("leaves an already-sourced MESH_METERING alone, quietly", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const jsm = fakeJsm({
      info: (name: string) => ({
        config: name === METERING_STREAM
          ? { name, sources: [{ name: EVENTS_STREAM, filter_subject: METERING_SUBJECT }] }
          : { name },
      }),
    });
    expect(await ensureMeteringStream(jsm as never)).toBe(true);
    expect(jsm.streams.add).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
