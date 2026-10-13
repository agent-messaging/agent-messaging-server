// A company's internal agent network: a Claude Code agent and a LangChain
// agent work together over the mesh.
//
//   node examples/02-internal-network/run.mjs
//   HARNESS_COMMAND="claude -p" node examples/02-internal-network/run.mjs
//
// Both agents belong to one tenant, the company. The researcher is a LangChain
// chain (a prompt, a model and a parser) behind an offering. The writer runs a
// harness such as Claude Code for each request: it asks the researcher for
// notes over the mesh, gives them to the harness, and answers with what the
// harness wrote. A third agent, standing in for a person's tool, asks the
// writer for a paragraph.
//
// So that it runs anywhere, the LangChain chain uses LangChain's own scripted
// test model and the writer's harness is a small stand-in script. Set
// HARNESS_COMMAND to run Claude Code (`claude -p`) or any command that reads a
// prompt on stdin and writes the answer on stdout, and swap the scripted model
// for a real one (researcher.mjs says where).

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, connect, enroll, run, say, tenant } from "../lib/mesh.mjs";
import { researchChain } from "./researcher.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = process.env.HARNESS_COMMAND ?? `"${process.execPath}" "${join(HERE, "stand-in-harness.mjs")}"`;

/** Run the harness once: the prompt on stdin, the answer on stdout. */
function harness(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(HARNESS, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`the harness exited ${code}`))));
    child.stdin.end(prompt);
  });
}

const company = await tenant(`northwind-${run}`);
const [researcherAgent, writerAgent, askerAgent] = await Promise.all([
  enroll(company, "researcher (LangChain)"),
  enroll(company, "writer (Claude Code)"),
  enroll(company, "someone's assistant"),
]);

// The LangChain agent.
const researcher = await connect(researcherAgent);
const chain = researchChain();
researcher.onRequest("notes", async (input) => ({ notes: await chain.invoke({ topic: input.topic }) }));
await researcher.register({
  name: "researcher",
  description: "Gathers short notes on a topic (a LangChain chain).",
  visibility: "unlisted",
  offerings: [{ id: "notes", name: "Notes", description: "Three short notes on a topic." }],
});

// The harness agent. It works with the researcher, then has its harness write.
const writer = await connect(writerAgent);
writer.onRequest("paragraph", async (input) => {
  const notes = await writer.request(researcherAgent.id, "notes", { topic: input.topic }, { timeout_ms: 30_000 });
  const prompt = `Write one short paragraph about ${input.topic} from these notes:\n${notes.payload.output.notes}`;
  return { paragraph: await harness(prompt), notes_from: "researcher" };
});
await writer.register({
  name: "writer",
  description: "Writes a paragraph on a topic, with notes from the researcher.",
  // Listed, so other agents on this mesh find it by what it offers. A mesh a
  // company runs for itself is its internal network; the researcher stays
  // unlisted, reached only by agents that know its id.
  visibility: "public",
  offerings: [{ id: "paragraph", name: "Paragraph", description: "One paragraph on a topic." }],
});
say(`Two agents of ${company} are on the mesh: a LangChain researcher and a harness writer (${process.env.HARNESS_COMMAND ? process.env.HARNESS_COMMAND : "the stand-in harness"}).`);

const asker = await connect(askerAgent);
const found = await asker.discover({ offering_id: "paragraph" });
check((found.agents ?? []).some((a) => a.id === writerAgent.id), "the writer is found by what it offers");
const answer = await asker.request(writerAgent.id, "paragraph", { topic: "store and forward messaging" }, { timeout_ms: 120_000 });
const paragraph = answer.payload?.output?.paragraph ?? "";
check(paragraph.length > 0 && answer.payload.output.notes_from === "researcher", "the writer asked the researcher, ran its harness and answered");
say(`\n${paragraph}\n`);

await Promise.all([researcher, writer, asker].map((m) => m.close()));
say("Done: two kinds of agent, one company network.");
process.exit(0);
