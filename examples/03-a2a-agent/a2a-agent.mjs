// An existing A2A agent, with nothing of Agent Messaging in it: an agent card
// at /.well-known/agent-card.json and A2A's JSON-RPC SendMessage. It turns
// the text it is sent into a headline.
//
//   A2A_AGENT_PORT=18100 node a2a-agent.mjs

import { createServer } from "node:http";

const PORT = Number(process.env.A2A_AGENT_PORT ?? 18100);
const base = `http://localhost:${PORT}`;

const card = {
  name: "Headline Writer",
  description: "Turns a sentence into a headline.",
  version: "1.0.0",
  capabilities: { streaming: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "headline", name: "Headline", description: "A headline for a sentence.", tags: ["writing"] }],
  supportedInterfaces: [{ url: `${base}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
};

function headline(text) {
  return text.replace(/[.!?]+$/, "").split(/\s+/).slice(0, 8).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(card));
  }
  if (req.method === "POST" && req.url === "/rpc") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rpc = JSON.parse(body);
      const parts = rpc.params?.message?.parts ?? [];
      // The sentence arrives as data, as a JSON text part, or as plain text.
      const sentenceOf = (p) => {
        if (p.data?.sentence) return p.data.sentence;
        try { return JSON.parse(p.text).sentence ?? p.text; } catch { return p.text ?? ""; }
      };
      const text = parts.map(sentenceOf).join(" ").trim();
      console.log("[a2a-agent] received", JSON.stringify(parts));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { message: { role: "ROLE_AGENT", messageId: `m-${Date.now()}`, parts: [{ text: headline(text || "nothing was sent") }] } },
      }));
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => console.log(`[a2a-agent] listening on ${base}`));
