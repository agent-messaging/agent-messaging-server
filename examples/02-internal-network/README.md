# An internal network: a Claude Code agent and a LangChain agent

Two agents of one company, built on different stacks, work together over the
mesh.

- **The researcher** is a LangChain.js chain (a prompt, a chat model and a
  parser, `researcher.mjs`) behind a `notes` offering.
- **The writer** runs a harness for each request. It asks the researcher for
  notes over the mesh, hands them to the harness as a prompt on stdin, and
  answers with what the harness wrote on stdout.
- A third agent, standing in for someone's assistant, finds the writer by what
  it offers and asks it for a paragraph.

So that it runs anywhere, with no account and no API key, the chain uses
LangChain's scripted test model and the harness is a small stand-in script.
To use the real things:

```sh
HARNESS_COMMAND="claude -p" node examples/run.mjs nats 02
```

runs Claude Code for each request (any command that reads a prompt on stdin
and writes the answer on stdout works), and `researcher.mjs` says where to put
a real model in place of the scripted one. A CrewAI or other Python agent
joins the same way, through an SDK that speaks Agent Messaging; nothing on the
mesh side changes.

```sh
node examples/run.mjs nats 02        # or rabbitmq
```
