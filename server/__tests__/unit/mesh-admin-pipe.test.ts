/**
 * The mesh-admin CLI (tools/mesh-admin.mjs) run as a program with its output
 * piped: a `--json` answer far larger than a pipe's buffer arrives whole.
 * Before, the CLI called process.exit() straight after writing, and stdout to
 * a pipe is asynchronous, so a large `agents list --json` was cut at 64 KB
 * (the pipe's buffer) whenever the reader had not taken it yet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const CLI = fileURLToPath(new URL("../../tools/mesh-admin.mjs", import.meta.url));
const TOKEN = "t".repeat(43);

/** Enough agents for an answer of about a megabyte. */
const agents = Array.from({ length: 4000 }, (_, i) => ({
  key: `U${String(i).padStart(55, "A")}`,
  tenant: `tenant-${i % 7}`,
  label: `agent number ${i} with a label long enough to make the answer large`,
  listed: i % 2 === 0,
}));

describe("mesh-admin --json through a pipe", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}` || req.url !== "/admin/v1/agents") {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "no such route" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ agents }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("writes the whole answer before it ends, even when the reader is slow", async () => {
    const child = spawn(process.execPath, [CLI, "agents", "list", "--json", "--url", url], {
      env: { ...process.env, MESH_ADMIN_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // A reader that is not ready at once: the pipe's buffer fills, and what
    // is left waits in the CLI until it is taken.
    child.stdout.pause();
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = new Promise<number | null>((r) => child.on("close", (c) => r(c)));
    await new Promise((r) => setTimeout(r, 1500));
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stdout.resume();
    expect(await code, stderr).toBe(0);
    const out = Buffer.concat(chunks).toString("utf8");
    expect(out.length).toBeGreaterThan(256 * 1024);
    expect(JSON.parse(out).agents).toHaveLength(agents.length);
  }, 30_000);
});
