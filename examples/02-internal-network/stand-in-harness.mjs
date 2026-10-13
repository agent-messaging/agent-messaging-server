// A stand-in for a harness such as Claude Code: it reads a prompt on stdin and
// writes an answer on stdout, the same contract `claude -p` keeps. It turns the
// notes in the prompt into one paragraph, so the example runs with no account
// and no network beyond the mesh.

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const topic = /about (.+?) from these notes/.exec(prompt)?.[1] ?? "the topic";
const notes = prompt
  .split("\n")
  .filter((l) => l.startsWith("- "))
  .map((l) => l.slice(2).replace(/\.$/, ""));
const body = notes.length ? `${notes.join(". ")}.` : "There were no notes.";
process.stdout.write(`On ${topic}: ${body}\n`);
