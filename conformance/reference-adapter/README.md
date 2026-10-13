# The reference adapter (for the conformance suite)

The reference adapter gives a command-line agent, such as a harness like
Claude Code, an inbox on a mesh. The conformance suite's adapter tests (c12,
c13 and c15) run it against the mesh under test, and so does the suite's own
echo agent (t02, t05).

This folder holds a copy of the adapter's runtime files only, so the suite runs
from this repository alone. It is not developed here, and it is licensed under
the MIT License (`package.json`). It runs this repository's SDK:
`node tools/conformance.mjs install` links `node_modules/agentmesh` to
`../../sdk-typescript`.

When an adapter release carries what these tests need (the AMQP transport and
the enrollment check on a mesh with no naming service), this copy is replaced
by that release, pinned by URL.
