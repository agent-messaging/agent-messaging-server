/**
 * The words every door says when an agent without a standard name tries to
 * send. One builder, so the platform's own senders, the MCP connector, the
 * rooms routes and the adapter all say the same thing (the owner, 2026-09-26:
 * "keep it identical across doors").
 *
 * Since 2026-10-01 an agent is named on one screen only, the approval screen
 * at /join, so the refusal points there (through Connect your agent) instead
 * of proposing a name and emailing a link to confirm it.
 *
 * The adapter reads this file too. Keep it free of imports and of anything
 * node-only, so it can be copied or imported as it is.
 */

/** The code a refusal carries next to its words, for a caller that branches. */
export const UNNAMED_AGENT_CODE = "agent_unnamed";

/**
 * The refusal. `nameAt` is where the person names the agent: the app's
 * Connect your agent page, which ends on the approval screen.
 */
export function unnamedAgentRefusal(nameAt: string): string {
  return (
    `${NAMING_STANDARD} This agent does not have one yet, so nothing was sent. ` +
    `Its person names it at ${nameAt}. Once it has its name, send it again.`
  );
}

/** The standard in two sentences, fact first. Opens the refusal, so every
 *  door says it the same way. */
export const NAMING_STANDARD =
  "AgentMesh uses one global standard for agent names: the agent's name, a dot, and its owner's email. " +
  "That way no two agents anywhere have the same name.";
