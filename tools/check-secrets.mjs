#!/usr/bin/env node
// Fails when a file git would commit looks like it holds a secret: an nkey
// seed, a JWT, a private key, a cloud or service token, a connection string
// with a password in it, or a file named like a credential.
//
//   node tools/check-secrets.mjs
//
// The test vectors the specification publishes are seeds by shape and control
// nothing; each is allowed by its exact value, with the reason, so a new seed
// anywhere still fails.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PATTERNS = [
  ["nkey seed", /\bS[UACON][A-Z2-7]{54,56}\b/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["enrollment key", /\bam_[A-Za-z0-9_-]{24,}/g],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["token", /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[\w-]{10,}|npm_[A-Za-z0-9]{30,})\b/g],
  ["connection string with a password", /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|nats):\/\/[^\s"'@/:]+:[^\s"'@/]+@[^\s"']+/gi],
];

const ALLOWED = [
  [/^SUAEGDPNTWXACIF45CA23BUY36RIMWZXW5LEHSEOK2ONS5JWJ7PBC2EWBA$/, "the specification's published signing test identity"],
  [/^SUAKUHTBUGFZ3NORTJZZBQUZCETUDR5SUPVOUVYRSO7ZU5JJNZNH2POCWE$/, "the specification's published delegation vector"],
  [/^SAAJ4CG7I4PNGYI5UX35JJRPCPZIOALHKDKMKSHJ3GSIM2NWDOVUOKKENQ$/, "the published t13 fixture seed"],
  [/^(amqp|postgres):\/\/(user:pass|user:password|mesh-core:p%40ss%20word)@/, "a placeholder in a comment or a URL-parsing test"],
];

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter((f) => f && existsSync(join(ROOT, f)));

let found = 0;
for (const f of files) {
  if (/(^|\/)\.env(\.(?!example$)|$)|\.(pem|key|p12|pfx|creds|nk|token|password)$|(^|\/)id_(rsa|ed25519)$/.test(f)) {
    console.log(`FINDING  credential-shaped file  ${f}`);
    found++;
  }
  const buf = readFileSync(join(ROOT, f));
  if (buf.includes(0)) continue;
  buf.toString("utf8").split(/\r?\n/).forEach((line, i) => {
    for (const [kind, re] of PATTERNS) {
      for (const m of line.matchAll(re)) {
        if (ALLOWED.some(([v]) => v.test(m[0]))) continue;
        console.log(`FINDING  ${kind.padEnd(20)} ${f}:${i + 1}  ${m[0].slice(0, 24)}...`);
        found++;
      }
    }
  });
}
console.log(`${files.length} files checked, ${found} finding(s).`);
process.exit(found ? 1 : 0);
