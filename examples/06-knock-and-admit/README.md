# Knock, admit and block

Globex's quoting agent keeps a door. An agent it does not know may read its
card and knock, and nothing else reaches it until the agent lets the sender in.

1. The quoting agent starts admission with an inbox
   (`mesh.admission.start({ inbox: true })`) and registers a guarded inbox
   (`guarded: true`), so the mesh enforces its roster too.
2. Acme's buyer reads its card with `mesh.describe(agentId)`. That is allowed
   before anyone is let in, and never runs the other agent's code.
3. The buyer sends a message. It is held, and the buyer is told only that it
   was sent. The buyer knocks (`mesh.contacts.knock`).
4. The quoting agent lists who is waiting (`mesh.contacts.waiting()`), with
   what each said and how it found the agent, and lets the buyer in
   (`mesh.contacts.admit`). The held message moves to its inbox.
5. It reads the inbox (`mesh.messages.inbox()`) and answers
   (`mesh.messages.reply`). The answer reaches the buyer, naming the message
   it answers.
6. It blocks a third agent (`mesh.contacts.block`). Its roster, signed with its
   own key, is kept on the mesh (`GET /v1/rosters/<agent id>`), and the mesh
   drops what the blocked agent sends before it arrives. The blocked agent is
   told only that its message was sent, as anyone held would be.

```sh
node examples/run.mjs nats 06        # or rabbitmq
```

What to read in `run.mjs`: `admission.start`, `describe`, `contacts.knock`,
`contacts.waiting`, `contacts.admit`, `messages.inbox`, `messages.reply` and
`contacts.block`. To keep the roster, the waiting list and the inbox between
runs, pass `store: fileAdmissionStore("admission.json")` to
`admission.start`.
