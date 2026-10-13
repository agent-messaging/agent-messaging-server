/**
 * Input an agent cannot use (SPEC §12.2 INPUT_NOT_UNDERSTOOD, Common Agent
 * §4.7.1, docs/input-handling-plan.md).
 *
 * Every agent answers every message it admits, and a message whose input does
 * not fit what the agent declares gets one standard reply: a sentence a
 * person can act on, and fixed fields an agent can act on. This module is the
 * mechanical half, shared by the SDK's dispatch and the mesh adapter, so both
 * read an agent's declarations the same way:
 *
 *   - fitCheck: does this message carry what the offering declares?
 *   - inputNotUnderstood: the standard reply when it does not;
 *   - isHelpQuestion + cardText: "what can you do?" answered from the card;
 *   - conversionRequest + checkConversion + applyConversion: asking the
 *     converter agent to read the message into the declared input, and
 *     checking its answer before anything is used. The converter never has
 *     the last word: a field it names must be declared, fit its kind, and rest
 *     on words the sender actually wrote.
 *
 * Nothing here calls a model or the network.
 */

export const INPUT_NOT_UNDERSTOOD = "INPUT_NOT_UNDERSTOOD";
/** The converter's offerings (role input-converter v1). */
export const CONVERT_OFFERING = "input.convert";
export const ADAPT_OFFERING = "output.adapt";
/** The Mesh Provided converter. */
export const DEFAULT_CONVERTER = "converter.platform@agentmesh.ai";
/** How long the shared layer waits for the converter before it answers with
 *  the standard reply instead. Nothing may depend on the converter to answer. */
export const CONVERTER_TIMEOUT_MS = 8_000;
/** A converted field below this confidence counts as missing. */
export const MIN_CONFIDENCE = 0.7;
/** Work declared longer than this is confirmed with the sender before it runs. */
export const LONG_JOB_SECONDS = 300;
/** How long a converted message waits for the sender's yes. */
export const CONFIRM_WINDOW_MS = 30 * 60_000;

export type MissReason = "missing_input" | "not_a_request" | "offering_unclear";

export interface DeclaredInput {
  name: string;
  kind: string;
  required?: boolean;
  one_of?: string;
}

export interface DeclaredOffering {
  id: string;
  name?: string;
  does?: string;
  inputs?: DeclaredInput[];
  examples?: string[];
  /** How the work is controlled (Common Agent 12.3 `how.control`), when
   *  declared: "script" is a fixed program, which cannot read a request in
   *  words; anything else (a model) can, so its messages are its own to read. */
  control?: string;
}

/** Whether an offering's work is a fixed program: the only kind the fit check
 *  refuses for. An offering a model controls reads words itself, and one that
 *  does not say is given the benefit of the doubt. */
export function isScripted(o: DeclaredOffering): boolean {
  return o.control === "script";
}

export interface FileRef {
  name?: string;
  media_type?: string;
}

const TEXT_KINDS = new Set(["text", "document", "identifier"]);
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/i;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (s: string, max = 300): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

// ── what an agent declares ──────────────────────────────────────────────────

function readInputs(v: unknown): DeclaredInput[] {
  if (!Array.isArray(v)) return [];
  const out: DeclaredInput[] = [];
  for (const i of v) {
    if (!i || typeof i !== "object") continue;
    const r = i as Record<string, unknown>;
    const name = str(r.name).trim();
    const kind = str(r.kind).trim();
    if (!name || !kind) continue;
    // A grant (reached rather than furnished) is not something a message carries.
    if (r.external === true || r.via !== undefined) continue;
    out.push({
      name,
      kind,
      ...(r.required === true ? { required: true } : {}),
      ...(typeof r.one_of === "string" && r.one_of ? { one_of: r.one_of } : {}),
    });
  }
  return out;
}

/** The offerings of an Agent Descriptor (Common Agent §6.2), as the fit check reads them. */
export function offeringsFromDescriptor(doc: unknown): DeclaredOffering[] {
  const d = doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  const list = Array.isArray(d.offerings) ? d.offerings : [];
  const out: DeclaredOffering[] = [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    const id = str(r.id).trim();
    if (!id) continue;
    const examples = Array.isArray(r.examples) ? r.examples.filter((e): e is string => typeof e === "string" && !!e.trim()) : [];
    const how = r.how && typeof r.how === "object" ? (r.how as Record<string, unknown>) : null;
    out.push({
      id,
      ...(str(r.name) ? { name: str(r.name) } : {}),
      ...(str(r.does) ? { does: str(r.does) } : {}),
      inputs: readInputs(r.inputs),
      ...(examples.length ? { examples } : {}),
      ...(str(how?.control) ? { control: str(how?.control) } : {}),
    });
  }
  return out;
}

/** The offerings of a registration manifest (§8.1), whose inputs are a JSON
 *  schema: each property becomes an input, `required` from the schema. */
export function offeringsFromManifest(manifest: unknown): DeclaredOffering[] {
  const m = manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>) : {};
  const list = Array.isArray(m.offerings) ? m.offerings : Array.isArray(m.skills) ? m.skills : [];
  const out: DeclaredOffering[] = [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    const id = str(r.id).trim();
    if (!id) continue;
    const schema = r.input_schema && typeof r.input_schema === "object" ? (r.input_schema as Record<string, unknown>) : null;
    const props = schema?.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, Record<string, unknown>>) : {};
    const required = new Set(Array.isArray(schema?.required) ? (schema!.required as unknown[]).filter((x): x is string => typeof x === "string") : []);
    const inputs: DeclaredInput[] = Object.entries(props).map(([name, p]) => {
      const t = str(p?.type);
      const kind = t === "object" || t === "array" ? "application/json" : t === "integer" || t === "number" ? "number" : str(p?.format) === "uri" ? "url" : "text";
      return { name, kind, ...(required.has(name) ? { required: true } : {}) };
    });
    const examples = Array.isArray(r.examples) ? r.examples.filter((e): e is string => typeof e === "string" && !!e.trim()) : [];
    out.push({
      id,
      ...(str(r.name) ? { name: str(r.name) } : {}),
      ...(str(r.description) ? { does: str(r.description) } : {}),
      inputs,
      ...(examples.length ? { examples } : {}),
    });
  }
  return out;
}

/** Whether any offering declares an input that is more than free text. An
 *  agent that takes only text (a conversation) has no wrong format to catch. */
export function declaresStructuredInputs(offerings: DeclaredOffering[]): boolean {
  return offerings.some((o) => (o.inputs ?? []).some((i) => !TEXT_KINDS.has(i.kind)));
}

// ── what a message is ───────────────────────────────────────────────────────

const HELP_PHRASES = new Set([
  "help",
  "what can you do",
  "what do you do",
  "how do i use you",
  "how can i use you",
  "what do you accept",
  "what do you take",
  "what are you",
  "who are you",
  "how does this work",
]);

/** A help question: the whole message is one of the fixed phrases. Only the
 *  whole message counts, so "help me write facts from this page" is work. */
export function isHelpQuestion(text: unknown): boolean {
  const t = norm(str(text)).replace(/[?!.\s]+$/, "").replace(/^(hi|hello|hey)[,!.\s]+/, "").trim();
  return HELP_PHRASES.has(t);
}

/** A process runner's phase line (`run <id> phase <phase>: ...`): the runner's
 *  own grammar, answered by the agent's script, never by this layer. */
export function isRunnerLine(text: unknown): boolean {
  return /^\s*(>\s*)?run \S+ phase \S+:/.test(str(text));
}

export function isYes(text: unknown): boolean {
  const t = norm(str(text));
  return t.length <= 40 && /^(yes|y|yep|yeah|yup|correct|right|go ahead|ok|okay|sure|please do|that'?s right)\b/.test(t);
}

export function isNo(text: unknown): boolean {
  const t = norm(str(text));
  return t.length <= 40 && /^(no|n|nope|wrong|not right|cancel|stop|don'?t)\b/.test(t);
}

/**
 * The fields a message states in a form the fit check can read without a
 * model: a whole message that is one JSON object, or lines `name: value`
 * whose name is a declared input.
 */
export function statedFields(text: string, inputs: DeclaredInput[]): Record<string, unknown> {
  const t = text.trim();
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* not JSON; read it as lines */ }
  }
  const names = new Map(inputs.map((i) => [i.name.toLowerCase(), i.name]));
  const out: Record<string, unknown> = {};
  for (const line of t.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/.exec(line);
    const name = m ? names.get(m[1].toLowerCase()) : undefined;
    if (m && name) out[name] = m[2];
  }
  return out;
}

function stem(s: string): string {
  return s.toLowerCase().replace(/\.[a-z0-9]{1,8}$/, "").replace(/[\s_]+/g, "-").trim();
}

/** Whether one declared input is present in a message. */
export function inputPresent(
  input: DeclaredInput,
  msg: { text: string; files: FileRef[]; fields: Record<string, unknown> },
): boolean {
  const field = msg.fields[input.name];
  const hasField = field !== undefined && field !== null && !(typeof field === "string" && !field.trim());
  if (input.kind.includes("/")) {
    if (hasField) return true;
    const want = stem(input.name);
    return msg.files.some((f) => {
      const n = stem(str(f.name));
      return (!!n && (n === want || n.includes(want))) || (!!f.media_type && f.media_type === input.kind);
    });
  }
  if (input.kind === "url") return (hasField && URL_RE.test(String(field))) || URL_RE.test(msg.text);
  if (hasField) return true;
  return msg.text.trim().length > 0;
}

/** The offering a message is for: the one it names, the only one there is,
 *  or the one whose id or name its words say. Null when that is unclear. */
export function pickOffering(offerings: DeclaredOffering[], named: string | null | undefined, text: string): DeclaredOffering | null {
  if (named) {
    const hit = offerings.find((o) => o.id === named);
    if (hit) return hit;
  }
  if (offerings.length === 1) return offerings[0];
  const t = norm(text);
  const says = (w: string | undefined) => {
    const s = norm(w ?? "");
    if (!s) return false;
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(t);
  };
  const said = offerings.filter((o) => says(o.id) || says(o.name));
  return said.length === 1 ? said[0] : null;
}

export interface FitResult {
  fits: boolean;
  offering: DeclaredOffering | null;
  /** Input names (or "one of: a, b" for a group) the message does not carry. */
  missing: string[];
  reason?: MissReason;
  fields: Record<string, unknown>;
}

/** What the offering asks for that the message does not carry. */
export function missingFor(offering: DeclaredOffering, msg: { text: string; files: FileRef[]; fields: Record<string, unknown> }): string[] {
  const inputs = offering.inputs ?? [];
  const missing: string[] = [];
  for (const i of inputs) if (i.required && !inputPresent(i, msg)) missing.push(i.name);
  const groups = new Map<string, DeclaredInput[]>();
  for (const i of inputs) if (i.one_of) groups.set(i.one_of, [...(groups.get(i.one_of) ?? []), i]);
  for (const members of groups.values()) {
    if (!members.some((i) => inputPresent(i, msg))) missing.push(`one of: ${members.map((i) => i.name).join(", ")}`);
  }
  // Inputs declared and none required or grouped means the offering needs
  // nothing (Common Agent 6.2: that is what `one_of` exists to say otherwise),
  // so such a message fits and the agent answers it itself.
  return missing;
}

/**
 * Does this message carry what the offering it is for declares? Mechanical,
 * no model: see docs/input-handling-plan.md, "The fit check".
 */
export function fitCheck(args: {
  offerings: DeclaredOffering[];
  named?: string | null;
  text: unknown;
  files?: FileRef[];
  fields?: Record<string, unknown>;
}): FitResult {
  const text = str(args.text);
  const files = args.files ?? [];
  const offering = pickOffering(args.offerings, args.named ?? null, text);
  if (!offering) {
    return { fits: false, offering: null, missing: [], reason: "offering_unclear", fields: {} };
  }
  const fields = { ...statedFields(text, offering.inputs ?? []), ...(args.fields ?? {}) };
  const missing = missingFor(offering, { text, files, fields });
  return missing.length
    ? { fits: false, offering, missing, reason: "missing_input", fields }
    : { fits: true, offering, missing: [], fields };
}

// ── the standard reply ──────────────────────────────────────────────────────

/** An input's kind in words a person reads. */
export function kindWords(kind: string): string {
  if (kind === "url") return "a web address";
  if (kind === "text" || kind === "document") return "text";
  if (kind === "identifier") return "a name or id";
  if (kind === "number") return "a number";
  if (kind === "application/json") return "a JSON file";
  const m = /^([a-z]+)\/([a-z0-9.+-]+)$/.exec(kind);
  if (!m) return kind;
  const sub = m[2].replace(/^x-/, "").replace(/\+.*$/, "").toUpperCase();
  if (m[1] === "image") return `a ${sub} image`;
  if (m[1] === "audio") return `a ${sub} recording`;
  if (m[1] === "video") return `a ${sub} video`;
  if (m[1] === "text") return `a ${sub === "PLAIN" ? "text" : sub} file`;
  return `a ${sub} file`;
}

function fileNameFor(i: DeclaredInput): string {
  if (i.kind === "application/json") return `${i.name}.json`;
  const m = /^[a-z]+\/([a-z0-9]+)/.exec(i.kind);
  return m ? `${i.name}.${m[1] === "plain" ? "txt" : m[1]}` : i.name;
}

/** An example message that fits the offering: its own first example, or one
 *  made from what it declares. */
export function exampleFor(o: DeclaredOffering): string {
  if (o.examples?.length) return oneLine(o.examples[0], 240);
  const inputs = o.inputs ?? [];
  const firstOfGroups = new Map<string, DeclaredInput>();
  for (const i of inputs) if (i.one_of && !firstOfGroups.has(i.one_of)) firstOfGroups.set(i.one_of, i);
  let use = inputs.filter((i) => i.required).concat([...firstOfGroups.values()]);
  if (!use.length && inputs.length) use = [inputs[0]];
  const title = o.name || o.id;
  const url = use.find((i) => i.kind === "url");
  const texts = use.filter((i) => TEXT_KINDS.has(i.kind) || i.kind === "number");
  const files = use.filter((i) => i.kind.includes("/"));
  let s = title;
  if (url) s += ` https://example.com`;
  if (texts.length) s += `, ${texts.map((i) => `${i.name}: ...`).join(", ")}`;
  if (files.length) s += `, with ${files.map(fileNameFor).join(" and ")} attached`;
  return s;
}

function acceptsList(o: DeclaredOffering): string {
  const inputs = o.inputs ?? [];
  if (!inputs.length) return "a plain message";
  return inputs
    .map((i) => `${i.name} (${kindWords(i.kind)}${i.required ? ", required" : i.one_of ? `, or another in its group` : ""})`)
    .join(", ");
}

export interface StandardReply {
  text: string;
  error: {
    code: typeof INPUT_NOT_UNDERSTOOD;
    message: string;
    retryable: false;
    details: {
      reason: MissReason;
      offering?: string;
      offerings: string[];
      missing?: string[];
      expected?: DeclaredInput[];
      example?: string;
      read_as?: string;
      how_to_use?: string;
    };
  };
}

/**
 * The standard reply to a message whose input does not fit (SPEC §12.2): one
 * sentence on what went wrong, what the agent accepts, and an example that
 * works, for a person; the same facts as fixed fields, for an agent.
 */
export function inputNotUnderstood(args: {
  agent: string;
  offerings: DeclaredOffering[];
  offering?: DeclaredOffering | null;
  reason: MissReason;
  missing?: string[];
  readAs?: string | null;
  howToUse?: string | null;
  hasFiles?: boolean;
}): StandardReply {
  const { agent, offerings } = args;
  const o = args.offering ?? (offerings.length === 1 ? offerings[0] : null);
  const readAs = args.readAs ? oneLine(args.readAs, 240).replace(/[.]$/, "") : null;
  const missing = args.missing ?? [];
  let why: string;
  if (args.reason === "offering_unclear" || !o) {
    why = `it does not say which of its offerings it is for (${offerings.map((x) => x.name || x.id).join(", ")})`;
  } else if (args.reason === "not_a_request") {
    why = `it does not read as a request for ${o.name || o.id}`;
  } else {
    const needs = missing.map((m) => {
      const i = (o.inputs ?? []).find((x) => x.name === m);
      return i ? `${m} (${kindWords(i.kind)})` : m;
    }).join(" and ");
    const many = missing.length > 1;
    why = `it needs ${needs || "an input it declares"}, and ${args.hasFiles ? `the attached files are not ${many ? "those" : "that"}` : `the message does not carry ${many ? "them" : "it"}`}`;
  }
  const lead = `${agent} could not use this message${readAs ? `, which reads as ${readAs}` : ""}: ${why}.`;
  const accepts = o
    ? ` ${o.name || o.id} takes: ${acceptsList(o)}.`
    : ` Its offerings: ${offerings.map((x) => `${x.name || x.id} (${acceptsList(x)})`).join("; ")}.`;
  const example = o ? exampleFor(o) : offerings[0] ? exampleFor(offerings[0]) : "";
  const text = `${lead}${accepts}${example ? ` For example: "${example}".` : ""}${args.howToUse ? ` More: ${args.howToUse}` : ""}`;
  return {
    text,
    error: {
      code: INPUT_NOT_UNDERSTOOD,
      message: text,
      retryable: false,
      details: {
        reason: o ? args.reason : "offering_unclear",
        ...(o ? { offering: o.id } : {}),
        offerings: offerings.map((x) => x.id),
        ...(missing.length ? { missing } : {}),
        ...(o ? { expected: o.inputs ?? [] } : {}),
        ...(example ? { example } : {}),
        ...(readAs ? { read_as: readAs } : {}),
        ...(args.howToUse ? { how_to_use: args.howToUse } : {}),
      },
    },
  };
}

/** "What can you do?", answered from the card: no model, the same words for everyone. */
export function cardText(args: { name: string; does?: string | null; offerings: DeclaredOffering[]; howToUse?: string | null }): string {
  const lines: string[] = [];
  lines.push(`${args.name}${args.does ? `: ${oneLine(args.does, 400)}` : "."}`);
  if (args.offerings.length) {
    lines.push("What you can ask it for:");
    for (const o of args.offerings.slice(0, 12)) {
      lines.push(`- ${o.name || o.id}${o.name ? ` (${o.id})` : ""}${o.does ? `: ${oneLine(o.does, 240)}` : ""}`);
      lines.push(`  It takes: ${acceptsList(o)}.`);
      lines.push(`  For example: "${exampleFor(o)}"`);
    }
  }
  if (args.howToUse) lines.push(`The full signed record: ${args.howToUse}`);
  lines.push("This answer comes from the agent's declared card, with no model involved.");
  return lines.join("\n");
}

// ── the converter ───────────────────────────────────────────────────────────

/** The converter's request (input.convert v1). Files are named, never sent. */
export function conversionRequest(args: { text: string; files?: FileRef[]; agent: string; offering: DeclaredOffering }): Record<string, unknown> {
  return {
    convert: "v1",
    text: args.text.slice(0, 6000),
    files: (args.files ?? []).map((f) => ({ name: str(f.name), media_type: str(f.media_type) })),
    target: {
      agent: args.agent,
      offering: {
        id: args.offering.id,
        ...(args.offering.name ? { name: args.offering.name } : {}),
        ...(args.offering.does ? { does: args.offering.does } : {}),
        inputs: args.offering.inputs ?? [],
        ...(args.offering.examples?.length ? { examples: args.offering.examples } : {}),
      },
    },
  };
}

export interface ConvertedField {
  value: unknown;
  confidence: number;
}

export type CheckedConversion =
  | { ok: true; fields: Record<string, ConvertedField>; readAs: string | null }
  | { ok: false; reason: MissReason; missing: string[]; readAs: string | null; dropped: string[] };

function valueFits(kind: string, value: unknown): boolean {
  if (kind === "url") return typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim());
  if (kind === "application/json" || kind.endsWith("+json")) {
    if (value && typeof value === "object") return true;
    if (typeof value !== "string") return false;
    try { const v = JSON.parse(value); return !!v && typeof v === "object"; } catch { return false; }
  }
  if (kind.includes("/")) return false; // a file of another kind cannot be written from words
  if (kind === "number") return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The converter's answer, checked against what the agent declares before any
 * of it is used (docs/input-handling-plan.md). A field is kept only when it is
 * declared, fits its kind, rests on words the sender wrote, and is held with
 * confidence; the rest counts as missing. The answer is used only when what
 * is kept makes the offering fit.
 */
export function checkConversion(answer: unknown, ctx: { offering: DeclaredOffering; text: string; files?: FileRef[] }): CheckedConversion {
  const a = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
  const readAs = typeof a.read_as === "string" && a.read_as.trim() ? oneLine(a.read_as, 300) : null;
  const required = missingFor(ctx.offering, { text: "", files: [], fields: {} });
  if (a.result === "not_a_request") {
    return { ok: false, reason: "not_a_request", missing: required, readAs: null, dropped: [] };
  }
  if (a.result !== "filled" && a.result !== "missing") {
    return { ok: false, reason: "missing_input", missing: required, readAs: null, dropped: [] };
  }
  const said = norm(ctx.text);
  const declared = new Map((ctx.offering.inputs ?? []).map((i) => [i.name, i]));
  const kept: Record<string, ConvertedField> = {};
  const dropped: string[] = [];
  const raw = a.fields && typeof a.fields === "object" ? (a.fields as Record<string, unknown>) : {};
  for (const [name, f] of Object.entries(raw)) {
    const input = declared.get(name);
    const r = f && typeof f === "object" ? (f as Record<string, unknown>) : {};
    const confidence = Math.max(0, Math.min(1, Number(r.confidence)));
    const from = str(r.from);
    const value = r.value;
    const ok = !!input
      && valueFits(input.kind, value)
      && Number.isFinite(confidence) && confidence >= MIN_CONFIDENCE
      && !!from.trim() && said.includes(norm(from))
      && (input.kind !== "url" || said.includes(norm(String(value))));
    if (ok) kept[name] = { value, confidence };
    else dropped.push(name);
  }
  const fields = Object.fromEntries(Object.entries(kept).map(([k, v]) => [k, v.value]));
  const missing = missingFor(ctx.offering, { text: "", files: ctx.files ?? [], fields });
  if (!missing.length && Object.keys(kept).length) return { ok: true, fields: kept, readAs };
  const said_missing = Array.isArray(a.missing) ? a.missing.filter((m): m is string => typeof m === "string" && declared.has(m)) : [];
  const all = [...new Set([...said_missing, ...missing])];
  return { ok: false, reason: "missing_input", missing: all.length ? all : required, readAs, dropped };
}

/**
 * The filled input, as the agent's job receives it: a text-like field as a
 * line `<name>: <value>` above the sender's own words, a JSON field as a file
 * `<name>.json`.
 */
export function applyConversion(text: string, fields: Record<string, ConvertedField>, offering: DeclaredOffering): { text: string; files: Array<{ name: string; media_type: string; content: string }> } {
  const declared = new Map((offering.inputs ?? []).map((i) => [i.name, i]));
  const lines: string[] = [];
  const files: Array<{ name: string; media_type: string; content: string }> = [];
  for (const [name, f] of Object.entries(fields)) {
    const kind = declared.get(name)?.kind ?? "text";
    if (kind === "application/json" || kind.endsWith("+json")) {
      const v = typeof f.value === "string" ? JSON.parse(f.value) : f.value;
      files.push({ name: `${name}.json`, media_type: "application/json", content: JSON.stringify(v, null, 2) });
    } else {
      lines.push(`${name}: ${String(f.value).replace(/\s+/g, " ").trim()}`);
    }
  }
  return { text: `${lines.join("\n")}${lines.length ? "\n\n" : ""}${text}`, files };
}

/** Whether a converted message waits for the sender's yes: costly or long work. */
export function needsConfirmation(args: { priceMicro?: number | null; jobSeconds?: number | null }): boolean {
  return (Number(args.priceMicro) || 0) > 0 || (Number(args.jobSeconds) || 0) > LONG_JOB_SECONDS;
}

/** The line the sender reads when the converter's reading is used. */
export function readAsLine(readAs: string | null, fields: Record<string, ConvertedField>, confirm: boolean): string {
  const what = readAs
    ? oneLine(readAs, 240).replace(/[.]$/, "")
    : Object.entries(fields).map(([k, v]) => `${k} = ${oneLine(typeof v.value === "string" ? v.value : JSON.stringify(v.value), 120)}`).join(", ");
  return confirm ? `I read this as: ${what}. Is that right? Reply yes to go ahead.` : `I read this as: ${what}. Working on it.`;
}
