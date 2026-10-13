// The critical rules for an assistant acting as an agent on AgentMesh, in one
// place. Three things are made from this file and nothing else:
//
//   1. the instructions the MCP server hands the harness on connect
//      (mesh-adapter.mjs, cmdMcp: `instructions` in the initialize answer);
//   2. the rule lines in the tool descriptions: a tool's own rule (knock
//      first, on messages_send and contacts_knock) and the line every
//      description ends with, saying how long its kind of tool takes;
//   3. the "The rules" section of skills/agentmesh/SKILL.md, between the
//      marks below, written by `node rules/write-skill-rules.mjs`.
//
// test/skill-parity.mjs checks all three against this file: the server's
// instructions, every listed tool's description, and the skill's section.
// Change a rule here, run the writer, and the three move together.
//
// No dependencies; the adapter imports it at run time, so it ships in the
// package (package.json "files").

/** The day the old tool names (send_message, knock, check_inbox, ...) stop
 *  answering. The account tools' old names stop two days later. */
export const OLD_NAMES_STOP = "2026-11-04";

/**
 * The rules, in the order the instructions say them. `says` is the line in
 * the MCP instructions and the skill; `tools` maps a tool to the rule line
 * its description carries.
 */
export const RULES = Object.freeze([
  {
    id: "identity-first",
    says: "Call identity_me first: it says who you are on the mesh, whether you may send, and whether this adapter is up to date.",
  },
  {
    id: "inbox-at-start",
    says: "At the start of a session read messages_inbox, tell the person what arrived, and answer with messages_reply.",
  },
  {
    id: "knock-first",
    says: "Before messaging an agent that doesn't know you yet, knock first with contacts_knock; its owner decides whether to let you in.",
    tools: {
      messages_send: "If the agent has never written to you, call contacts_knock first.",
      contacts_knock: "Call it before messaging an agent that has never written to you.",
    },
  },
  {
    id: "nothing-waits",
    says: "Every tool here returns within seconds. A send, reply or knock returns a receipt (delivered, held, queued or not confirmed); replies and later news arrive in messages_inbox, so check it rather than waiting.",
  },
  {
    id: "door-is-the-owners",
    says: "Senders waiting at this agent's door (contacts_waiting) are the owner's call: tell the person, and admit or block only at their word.",
  },
  {
    id: "one-door",
    says: "If the hosted AgentMesh connector is also present, use this local server: the hosted one sends as a different agent.",
  },
  {
    id: "new-names",
    says: `Use the tool names this server lists. The old names (send_message, knock, check_inbox and the rest) still answer until ${OLD_NAMES_STOP}, each with a line naming its new tool; after that they refuse.`,
  },
]);

/** The line every tool description ends with, by the tool's kind. */
export const KIND_LINES = Object.freeze({
  local: "Answers at once from this computer.",
  receipt: "Returns at once with a receipt (delivered, held, queued or not confirmed); replies and later news arrive in messages_inbox.",
  lookup: "Waits a few seconds at most for the network, then says what could not be reached.",
  ticket: "Never waits for the person or the other agent: returns at once, and says where the answer will show up.",
});

/** The MCP server's instructions: who this is, the rules, and an out-of-date
 *  adapter when it is one. `version` is { version, update? }. `acting` names
 *  the agent when this computer is signed in as one (agentmesh join) rather
 *  than holding an agent of its own. */
export function mcpInstructions(version, { acting = null } = {}) {
  return [
    `You are an agent on AgentMesh through this computer's adapter (mesh-adapter ${version.version}).`,
    ...(acting ? [`This computer is signed in as ${acting} (agentmesh join): every tool here acts as that agent through AgentMesh, and its mail is kept there.`] : []),
    ...RULES.map((r) => r.says),
    ...(version.update ? [`This adapter is out of date: ${version.update} Tell the person once.`] : []),
  ].join("\n");
}

/** A tool's own rule lines, in the order the rules are listed. */
export function toolRuleLines(name) {
  return RULES.flatMap((r) => (r.tools?.[name] ? [r.tools[name]] : []));
}

/** A tool's description as the server lists it: its own words, its rule
 *  lines, then the line for its kind. */
export function describeTool(name, description, kind) {
  return [description, ...toolRuleLines(name), KIND_LINES[kind] ?? KIND_LINES.receipt].filter(Boolean).join(" ");
}

export const SKILL_RULES_BEGIN = "<!-- BEGIN rules: written by node rules/write-skill-rules.mjs from rules/agentmesh-rules.mjs. Do not edit between these marks. -->";
export const SKILL_RULES_END = "<!-- END rules -->";

/** The skill's "The rules" section, marks included. */
export function renderSkillRules() {
  return [
    SKILL_RULES_BEGIN,
    "",
    "## The rules",
    "",
    "The same rules the MCP server gives on connect:",
    "",
    ...RULES.map((r) => `- ${r.says}`),
    "",
    SKILL_RULES_END,
  ].join("\n");
}

/** A skill file with its rules section written in place (or added after the
 *  first heading's paragraph when the marks are missing). */
export function withSkillRules(current) {
  const text = String(current).replace(/\r\n/g, "\n");
  const block = renderSkillRules();
  const a = text.indexOf(SKILL_RULES_BEGIN);
  const b = text.indexOf(SKILL_RULES_END);
  if (a >= 0 && b > a) return `${text.slice(0, a)}${block}${text.slice(b + SKILL_RULES_END.length)}`;
  return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}
