// An agent that keeps a door: strangers read its card, knock, and wait until
// it lets them in; one it blocks is stopped on the mesh.
//
//   node examples/06-knock-and-admit/run.mjs
//
// Globex's quoting agent starts admission with an inbox and registers a
// guarded inbox. Acme's buyer reads its card (describe), sends a message that
// is held, knocks, and is let in; the held message moves to the quoting
// agent's inbox, and its answer reaches the buyer. A third agent is blocked,
// and the mesh drops what it sends before it arrives.

import { MESH_API, check, connect, enroll, run, say, sleep, tenant } from "../lib/mesh.mjs";

const globex = await tenant(`globex-${run}`);
const acme = await tenant(`acme-${run}`);
const other = await tenant(`other-${run}`);
const quoter = await enroll(globex, "globex quoting agent");
const buyer = await enroll(acme, "acme buyer");
const stranger = await enroll(other, "unknown sender");

// The quoting agent's door: a stranger's message is held until it is let in,
// and what it lets in waits in an inbox it reads in its own time.
const q = await connect(quoter);
await q.admission.start({ inbox: true });
await q.register({
  name: "globex-quotes",
  description: "Quotes prices for Globex parts.",
  visibility: "public",
  public: { summary: "Quotes prices for Globex parts.", offerings: ["chat"] },
  offerings: [{ id: "chat", name: "Chat", description: "Ask for a quote." }],
  guarded: true,
});
say("Globex's quoting agent is on, with admission and a guarded inbox.");

const replies = [];
const b = await connect(buyer);
b.onRequest("chat", (input) => { replies.push(input); return { ok: true }; });
await b.register({ name: "acme-buyer", description: "Buys parts for Acme.", visibility: "unlisted", offerings: [{ id: "chat", name: "Chat", description: "Answers come here." }] });

// 1. Before it is let in, the buyer may read the card and knock, nothing else.
const card = await b.describe(quoter.id);
check(card.public?.summary === "Quotes prices for Globex parts.", `the buyer read the quoting agent's card before being let in (${JSON.stringify(card.public)})`);

const first = await b.messages.send({ to: quoter.id, text: "Price for 40 flanges?" });
check(first.delivered === false, `a message from a stranger is held, and the buyer is told only that it was sent (${first.note})`);

await b.contacts.knock({ to: quoter.id, via: "the Globex catalog" });
const waiting = (await q.contacts.waiting()).senders;
const asked = waiting.find((s) => s.agent_id === buyer.id);
check(asked?.said === "Price for 40 flanges?" && asked?.found_you_by === "the Globex catalog", `the quoting agent sees the buyer waiting, what it said and how it found it (${JSON.stringify(asked)})`);

// 2. Let in: what it already sent moves to the inbox, and gets an answer.
const admitted = await q.contacts.admit({ sender: buyer.id, note: "Acme, a customer" });
check(admitted.released === 1, `letting the buyer in released its held message to the inbox (${JSON.stringify(admitted)})`);
const msg = (await q.messages.inbox()).messages.find((m) => m.from === buyer.id);
check(msg?.text === "Price for 40 flanges?", "the held message is in the quoting agent's inbox");
const answered = await q.messages.reply({ inbox_id: msg.id, text: "$1,680 for 40." });
check(answered.delivered === true, "the quoting agent answered from its inbox, and the answer was delivered");
for (let i = 0; i < 50 && !replies.length; i++) await sleep(100);
check(String(replies[0]?.text ?? "").includes("$1,680 for 40.") && replies[0]?.in_reply_to === msg.id, "the buyer got the answer, naming the message it answers");
await q.messages.dismiss({ inbox_ids: [msg.id] });

// 3. Blocked: the roster is signed and kept on the mesh, which drops the mail.
const s = await connect(stranger);
await s.register({ name: "unknown-sender", description: "Sends things.", visibility: "unlisted", offerings: [] });
await q.contacts.block({ sender: stranger.id, note: "not a customer" });
const roster = await (await fetch(`${MESH_API}/v1/rosters/${quoter.id}`)).json();
check(roster.entries?.some((e) => e.subject === stranger.id && e.stance === "block") && typeof roster.sig === "string", "the quoting agent's signed roster, with the block, is kept on the mesh");
const spam = await s.messages.send({ to: quoter.id, text: "Buy now!" });
check(spam.delivered === false, "the blocked agent is told only that its message was sent, as anyone held would be");
await sleep(1500);
const seen = (await q.contacts.waiting()).senders.some((x) => x.agent_id === stranger.id) || (await q.messages.inbox()).messages.some((m) => m.from === stranger.id);
check(!seen, "nothing from the blocked agent reached the quoting agent");

await s.close();
await b.close();
await q.close();
say("Done: describe, knock, admit, answer, block.");
process.exit(0);
