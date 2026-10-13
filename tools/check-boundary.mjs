#!/usr/bin/env node
// The server's boundary, checked on every change (CI's checks job).
//
// 1. Nothing leaves the server. Every file in server/, a2a-gateway/ and
//    sdk-typescript/ (tests included) imports only files inside those three
//    folders, Node's own modules, and packages its folder's package.json
//    declares. A relative import that climbs out of them, or a package nobody
//    declared, would build on one machine and not on a clean clone.
//
// 2. The core reaches the broker only through the storage layer
//    (server/src/storage/), which is what lets the same services run on NATS
//    JetStream or on RabbitMQ with Postgres. In every server source file
//    outside the layer it fails on an import from "nats" of anything but
//    `nkeys` (types included), on a call that reaches JetStream or the raw
//    connection (`.jetstream(`, `.jetstreamManager(`, `.views.kv(`,
//    `.views.os(`, `jetStreamOf(`), and on an import of the layer's JetStream
//    implementation (server/src/storage/jetstream/) instead of its door
//    (server/src/storage/index.ts). A file that has to stay is listed, with its
//    reason, in tools/storage-layer-baseline.json, which only shrinks: an entry
//    whose file no longer does it fails too. The SDK is the client side and has
//    its own transport interface, so rule 2 leaves it out.
//
// Both rules came from the boundary checks of the repository the server was
// carved out of (where they kept the server's code apart from a platform's);
// here a clean clone is the whole world, and the rules say so directly.
//
//   node tools/check-boundary.mjs              the check
//   node tools/check-boundary.mjs --self-test  proves each rule fails a new breach

import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isTest, resolveSpecifier, specifiers, stripComments } from "./lib/imports.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FOLDERS = ["server/", "a2a-gateway/", "sdk-typescript/"];
const LAYER = "server/src/storage/";
const JETSTREAM = "server/src/storage/jetstream/";
const BASELINE = "tools/storage-layer-baseline.json";
const ALLOWED_FROM_NATS = new Set(["nkeys"]);
const CALLS = [
  [/\.jetstream\s*\(/, ".jetstream("],
  [/\.jetstreamManager\s*\(/, ".jetstreamManager("],
  [/\.views\s*\.\s*kv\s*\(/, ".views.kv("],
  [/\.views\s*\.\s*os\s*\(/, ".views.os("],
  [/(?<![\w$.])jetStreamOf\s*\(/, "jetStreamOf("],
];
const CODE = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/;
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const folderOf = (f) => FOLDERS.find((p) => f.startsWith(p)) ?? null;
const packageName = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

function declared(folder) {
  const pkg = JSON.parse(readFileSync(join(ROOT, folder, "package.json"), "utf8"));
  return new Set([pkg.name, ...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
}

/** Rule 1, for one file: { file, what } for each import that leaves the server or names an undeclared package. */
export function leaves(file, src, { resolveSpec, packagesOf }) {
  const out = [];
  const folder = folderOf(file);
  for (const { spec } of specifiers(src)) {
    if (spec.startsWith(".")) {
      const to = resolveSpec(file, spec);
      const target = to ?? join(dirname(file), spec).replace(/\\/g, "/");
      if (!folderOf(target)) out.push({ file, what: `${spec} (${target}), outside server/, a2a-gateway/ and sdk-typescript/` });
      continue;
    }
    if (spec.startsWith("/") || /^[A-Za-z]:/.test(spec)) { out.push({ file, what: `${spec}, an absolute path` }); continue; }
    if (BUILTIN.has(spec) || BUILTIN.has(spec.split("/")[0]) || spec.startsWith("node:")) continue;
    // Virtual modules of the test runner and the bundler, and type-only names.
    if (spec === "vitest" || spec.startsWith("vitest/") || spec.startsWith("virtual:")) continue;
    const name = packageName(spec);
    if (!packagesOf(folder).has(name) && !packagesOf(folder).has(`@types/${name}`)) out.push({ file, what: `the package ${name}, which ${folder}package.json does not declare` });
  }
  return out;
}

/** Rule 2, for one file: { file, rule, what } for each way it reaches the broker outside the layer. */
export function breaches(file, src, resolveSpec) {
  const out = [];
  const code = stripComments(src);
  const re = /(?:^|;)[ \t]*(?:import|export)\s+(?:type\s+)?([^;"'`]*?)\s*from\s*["']nats["']/gm;
  for (const m of code.matchAll(re)) {
    const clause = m[1];
    const braces = clause.match(/\{([^}]*)\}/);
    if (clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim()) out.push({ file, rule: "nats-import", what: 'a default or namespace import of "nats"' });
    for (const part of braces ? braces[1].split(",") : []) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name && !ALLOWED_FROM_NATS.has(name)) out.push({ file, rule: "nats-import", what: `${name} from "nats"` });
    }
  }
  for (const [r, what] of CALLS) if (r.test(code)) out.push({ file, rule: "call", what });
  for (const { spec } of specifiers(src)) {
    const to = resolveSpec(file, spec);
    if (to && to.startsWith(JETSTREAM)) out.push({ file, rule: "layer-inside", what: to });
  }
  const seen = new Set();
  return out.filter((b) => !seen.has(key(b)) && seen.add(key(b)));
}

const key = (b) => `${b.file} | ${b.rule} | ${b.what}`;

export function check({ files, read, resolveSpec, packagesOf, baseline }) {
  const problems = [];
  const code = files.filter((f) => folderOf(f) && CODE.test(f) && !f.endsWith(".d.ts") && !f.includes("/node_modules/") && !f.includes("/dist/"));
  for (const f of code) {
    for (const l of leaves(f, read(f), { resolveSpec, packagesOf })) problems.push(`${l.file} imports ${l.what}`);
  }
  const listed = new Map();
  for (const e of baseline.entries ?? []) {
    if (listed.has(key(e))) problems.push(`${BASELINE} lists ${key(e)} twice`);
    listed.set(key(e), e);
    if (typeof e.reason !== "string" || e.reason.trim().length < 10) problems.push(`${BASELINE}: ${key(e)} has no reason`);
  }
  const found = new Set();
  const core = code.filter((f) => (f.startsWith("server/src/") || f.startsWith("server/tools/")) && !f.startsWith(LAYER) && !isTest(f));
  for (const f of core) {
    for (const b of breaches(f, read(f), resolveSpec)) {
      found.add(key(b));
      if (listed.has(key(b))) continue;
      problems.push(b.rule === "layer-inside"
        ? `${b.file} imports ${b.what}, the layer's JetStream implementation. Import the layer's door, server/src/storage/index.ts, instead.`
        : `${b.file} reaches the broker outside the storage layer (${b.what}). Ask the layer for the store or the messaging instead (server/src/storage/index.ts: storageOf, messagingOf), or, if it has to stay, add it to ${BASELINE} with the reason.`);
    }
  }
  for (const [k] of listed) if (!found.has(k)) problems.push(`${BASELINE} lists ${k}, and that file no longer does it; take the entry out (the list only shrinks)`);
  return { problems, files: code.length, core: core.length };
}

function realInputs() {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter((f) => f && existsSync(join(ROOT, f)));
  const cache = new Map();
  return {
    files,
    read: (f) => readFileSync(join(ROOT, f), "utf8"),
    resolveSpec: (from, spec) => resolveSpecifier(ROOT, from, spec),
    packagesOf: (folder) => (cache.has(folder) ? cache.get(folder) : cache.set(folder, declared(folder)).get(folder)),
    baseline: JSON.parse(readFileSync(join(ROOT, BASELINE), "utf8")),
  };
}

function selfTest() {
  const real = realInputs();
  const fake = "server/src/registry/new-file.ts";
  const withFile = (src, resolveExtra = {}) => ({
    ...real,
    files: [...real.files, fake],
    read: (f) => (f === fake ? src : real.read(f)),
    resolveSpec: (from, spec) => (from === fake && resolveExtra[spec] !== undefined ? resolveExtra[spec] : real.resolveSpec(from, spec)),
  });
  const cases = [
    ["an import that climbs out of the server", withFile('import { x } from "../../../platform/thing.js";\n'), /new-file\.ts imports \.\.\/\.\.\/\.\.\/platform\/thing\.js .*outside/],
    ["a package the server does not declare", withFile('import express from "express";\n'), /the package express, which server\/package\.json does not declare/],
    ["a JetStream type", withFile('import type { JetStreamClient } from "nats";\n'), /JetStreamClient from "nats"/],
    ["the stream manager", withFile("export async function f(nc: any) { return nc.jetstreamManager(); }\n"), /\.jetstreamManager\(/],
    ["the layer's JetStream implementation", withFile('import { ensureKvBucket } from "../storage/jetstream/kv.js";\n', { "../storage/jetstream/kv.js": "server/src/storage/jetstream/kv.ts" }), /imports server\/src\/storage\/jetstream\/kv\.ts/],
    ["a stale list entry", { ...real, baseline: { entries: [...(real.baseline.entries ?? []), { file: "server/src/registry/gone.ts", rule: "call", what: ".jetstream(", reason: "a stale entry for the self-test" }] } }, /no longer does it/],
  ];
  let bad = 0;
  for (const [name, input, want] of cases) {
    const { problems } = check(input);
    if (!problems.some((p) => want.test(p))) { bad++; console.error(`self-test: ${name} did not fail as it should (${problems.join("; ") || "no problems"})`); }
  }
  const ok = check(withFile('import { nkeys } from "nats";\nimport { createHash } from "node:crypto";\nimport { x } from "../../../sdk-typescript/src/index.js";\n', { "../../../sdk-typescript/src/index.js": "sdk-typescript/src/index.ts" }));
  if (ok.problems.length) { bad++; console.error(`self-test: nkeys, a Node module or the SDK folder was refused: ${ok.problems.join("; ")}`); }
  const clean = check(real);
  if (clean.problems.length) { bad++; console.error(`self-test: the real tree has problems: ${clean.problems.join("; ")}`); }
  if (bad) process.exit(1);
  console.log(`boundary self-test: ${cases.length} cases each fail, allowed imports pass, and the real tree passes`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const { problems, files, core } = check(realInputs());
    if (problems.length) {
      for (const p of problems) console.error(`FAIL  ${p}`);
      console.error(`\nboundary: FAIL (${problems.length} problem${problems.length === 1 ? "" : "s"})`);
      process.exit(1);
    }
    console.log(`boundary: PASS (${files} files stay inside the server; ${core} server files reach the broker only through the storage layer, apart from the listed ones)`);
  }
}
