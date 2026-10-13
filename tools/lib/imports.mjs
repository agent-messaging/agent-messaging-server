// Reading the imports and strings of TypeScript and JavaScript files without a parser.
//
// The boundary check (tools/check-boundary.mjs) needs "which files does this
// file load". It runs before anything is installed, so it cannot lean on the
// TypeScript compiler. A small lexer
// strips comments and collects strings, and the import forms the repository
// uses are matched on what is left.

import { existsSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const BACKTICK = "`";
const WORD = /[A-Za-z0-9_$]/;
// After these keywords a slash starts a regular expression, not a division.
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "throw", "new"]);

/**
 * One pass over a source file: the text with every comment replaced by spaces
 * (strings, templates and code kept, so lines still match), and the contents
 * of every string and of every literal piece of a template.
 *
 * It knows enough JavaScript for the repository's code: single, double and
 * template quotes with escapes, template substitutions nested to any depth,
 * line and block comments, and regular expression literals, which it tells
 * from division by the token before the slash.
 */
export function lex(src) {
  let code = "";
  const strings = [];
  const n = src.length;
  let i = 0;
  // One entry per template substitution we are inside: the brace depth at its ${.
  const subs = [];
  let depth = 0;
  // The last significant character of code, and the word it ends, if any.
  let prev = "";
  let prevWord = "";

  const regexCanStart = () => prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || REGEX_AFTER_WORD.has(prevWord);

  // At the first character after a backtick, or after the } that closes a ${.
  const templatePiece = () => {
    let piece = "";
    while (i < n && src[i] !== BACKTICK) {
      if (src[i] === "\\") {
        code += src[i] + (src[i + 1] ?? "");
        piece += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (src[i] === "$" && src[i + 1] === "{") {
        code += "${";
        i += 2;
        subs.push(depth);
        strings.push(piece);
        prev = "{";
        prevWord = "";
        return;
      }
      code += src[i];
      piece += src[i];
      i++;
    }
    strings.push(piece);
    if (i < n) { code += BACKTICK; i++; }
    prev = BACKTICK;
    prevWord = "";
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") { code += " "; i++; }
      continue;
    }
    if (c === "/" && d === "*") {
      code += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { code += src[i] === "\n" ? "\n" : " "; i++; }
      if (i < n) { code += "  "; i += 2; }
      continue;
    }
    if (c === "/" && regexCanStart()) {
      // A regular expression literal, copied as it is and never read as a string.
      code += c;
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        const r = src[i];
        if (r === "\\") { code += r + (src[i + 1] ?? ""); i += 2; continue; }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        code += r;
        i++;
      }
      if (i < n && src[i] === "/") { code += "/"; i++; }
      while (i < n && /[a-z]/i.test(src[i])) { code += src[i]; i++; }
      prev = "/";
      prevWord = "";
      continue;
    }
    if (c === '"' || c === "'") {
      code += c;
      i++;
      let piece = "";
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          code += src[i] + (src[i + 1] ?? "");
          piece += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        code += src[i];
        piece += src[i];
        i++;
      }
      strings.push(piece);
      if (i < n && src[i] === c) { code += c; i++; }
      prev = c;
      prevWord = "";
      continue;
    }
    if (c === BACKTICK) {
      code += c;
      i++;
      templatePiece();
      continue;
    }
    if (c === "}" && subs.length && subs[subs.length - 1] === depth) {
      subs.pop();
      code += c;
      i++;
      templatePiece();
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") depth--;
    code += c;
    i++;
    if (WORD.test(c)) {
      prevWord = WORD.test(prev) ? prevWord + c : c;
      prev = c;
    } else if (!/\s/.test(c)) {
      prev = c;
      prevWord = "";
    }
  }
  return { code, strings };
}

/** The text with every comment replaced by spaces; strings and code are kept. */
export function stripComments(src) {
  return lex(src).code;
}

// A static import or export-from starts a statement: at the start of a line,
// or after a semicolon. Anchoring it there keeps the words "import ... from"
// inside a string or a template from reading as an import.
const STATIC = /(?:^|;)[ \t]*(import|export)\s+(type\s+)?([\w*{}\s,$]*?\s*from\s*)?(["'])([^"'\n]+)\4/gm;
const DYNAMIC = /(?<![\w$.])(?:(typeof)\s+)?import\s*\(\s*(["'])([^"'\n]+)\2\s*\)/g;
const REQUIRE = /(?:^|[^\w$.])require\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

/**
 * Every module specifier a file names, with whether it is type-only (an
 * `import type`, an `export type`, a `{ type A, type B }` list, or a
 * `typeof import("...")`). Type-only imports load nothing at run time but
 * still need the file to typecheck.
 */
export function specifiers(src) {
  const text = stripComments(src);
  const found = [];
  for (const m of text.matchAll(STATIC)) {
    const clause = m[3] ?? "";
    let typeOnly = Boolean(m[2]);
    const braces = clause.match(/\{([^}]*)\}/);
    if (!typeOnly && braces && !/^\s*[\w$]+\s*,/.test(clause) && !clause.includes("*")) {
      const names = braces[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length && names.every((s) => s.startsWith("type "))) typeOnly = true;
    }
    found.push({ spec: m[5], typeOnly });
  }
  for (const m of text.matchAll(DYNAMIC)) found.push({ spec: m[3], typeOnly: Boolean(m[1]) });
  for (const m of text.matchAll(REQUIRE)) found.push({ spec: m[2], typeOnly: false });
  return found;
}

const TRY = {
  ".js": [".ts", ".tsx", ".js", ".d.ts"],
  ".mjs": [".mts", ".mjs", ".d.mts"],
  ".cjs": [".cts", ".cjs"],
  "": [".ts", ".tsx", ".js", ".mjs", ".d.ts", "/index.ts", "/index.js"],
};

const isFile = (abs) => existsSync(abs) && statSync(abs).isFile();

/**
 * The repo-relative file a relative specifier names, or null for a package
 * import or a file that is not there. `fromRel` is repo-relative, POSIX.
 */
export function resolveSpecifier(root, fromRel, spec) {
  if (!spec.startsWith(".")) return null;
  const base = normalize(join(dirname(fromRel), spec)).replace(/\\/g, "/");
  if (isFile(join(root, base)) && !/\.(js|mjs|cjs)$/.test(base)) return base;
  const ext = (base.match(/\.(js|mjs|cjs)$/) ?? [""])[0];
  const stem = base.replace(/\.(js|mjs|cjs)$/, "");
  for (const e of TRY[ext]) {
    const cand = stem + e;
    if (isFile(join(root, cand))) return cand;
  }
  if (ext && isFile(join(root, base))) return base;
  return null;
}

/** Is this a test file? Tests may reach anything; the boundary is about what runs. */
export const isTest = (p) => /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

/** Is this a source file the boundary checks? */
export const isSource = (p) => /\.(ts|tsx|mts|cts|mjs|cjs|js)$/.test(p) && !p.endsWith(".d.ts") && !isTest(p);

/**
 * The tier of a repo-relative path under a map of path prefixes to tiers.
 * The most specific (longest) entry wins, the same rule docs/ownership.json
 * uses. A path no entry covers has the tier `fallback`.
 */
export function tierOf(tiers, p, fallback = "platform") {
  let best = null;
  for (const key of Object.keys(tiers)) {
    const hit = key.endsWith("/") ? p.startsWith(key) : p === key;
    if (hit && (!best || key.length > best.length)) best = key;
  }
  return best ? tiers[best] : fallback;
}
