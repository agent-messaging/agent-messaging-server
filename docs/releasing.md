# Changes and releases

This repository is the only home of the Agent Messaging Server's source: the
server (`server/`), the A2A gateway (`a2a-gateway/`) and the TypeScript SDK
(`sdk-typescript/`). Everything is developed here, tested here and released
from here. Deployments run a release, never a copy of the source.

A few files here are copies of documents written where the specification is:
`conformance/` (the core profile of the conformance suite, and `SPEC.md`),
`a2a-gateway/MAPPING.md` and `docs/rabbitmq-binding.md`
(`tools/monorepo-export.json` lists them). A change to one of them is made
there and arrives here in a pull request; the server's own code, tests and
documents are changed here.

## A change

1. Open a pull request here. CI (`.github/workflows/ci.yml`) typechecks and
   tests the server, the gateway and the SDK, checks the boundary
   (`tools/check-boundary.mjs`), and brings a mesh up from empty on each broker
   to run the core conformance profile and every example against it.
2. Merge it when CI is green. A merged change is not released yet.

## A release

There are two kinds, with separate version numbers, because each can change
without the other.

**The server and the gateway** share one number, in `server/server-release.json`
(and the `version` of `server/package.json` and `a2a-gateway/package.json`).

1. Raise the number in a pull request, with what the release holds.
2. When it is merged, tag that commit `server-v<version>` and push the tag.
3. `.github/workflows/release-images.yml` builds both images from the tag,
   runs the smoke test (first-run from an empty volume, a live revocation, the
   gateway connecting) and publishes
   `ghcr.io/jeffrschneider/agent-messaging-server:<version>` and
   `ghcr.io/jeffrschneider/agent-messaging-a2a-gateway:<version>`.
   A published tag is never replaced.
4. Write the GitHub release for the tag, then move the image pins in
   `deploy/`, the README and `.env.example` to the new version.

Use a patch release (0.1.1) for fixes and anything that adds without changing
what is there, and a minor release (0.2.0) for a change a deployment has to
act on.

**The SDK** has its number in `sdk-typescript/package.json`.

1. Raise the number and add its section to `sdk-typescript/CHANGELOG.md` in a
   pull request.
2. When it is merged, tag that commit `sdk-v<version>` and push the tag.
3. `.github/workflows/release-sdk.yml` tests and builds the SDK, packs it,
   installs the tarball in an empty project, and attaches
   `agentmesh-<version>.tgz` and its SHA-256 to the GitHub release
   `sdk-v<version>`. A released version is never replaced.
4. Move the install lines (`sdk-typescript/README.md`, `examples/README.md`)
   and the peering suite's pin to the new version once the tarball is at the
   address below.

The same tarball is also served at
`https://storage.googleapis.com/agentmesh-releases/agentmesh-<version>.tgz`,
copied byte for byte from the GitHub release by the maintainers after it is
checked against the SHA-256 the release carries. Either address installs with
`npm install <url>`, without the npm registry.

A server release does not need a new SDK, and an SDK release does not need a
new server: the server builds against the SDK folder at the same commit.

## How a change reaches a deployment

A deployment pins a release and moves the pin when it is ready. For AgentMesh,
the hosted network this project's sponsor runs, that is:

1. the change is merged here, and released as above;
2. AgentMesh moves its pin (the release tag and its commit, and the SDK
   tarball's address and checksum) in its own repository, deploys that to its
   development mesh and runs the core, platform and naming conformance
   profiles there;
3. then to production.

So nothing merged here reaches AgentMesh until it is released and its pin
moves, and a change AgentMesh needs in the server is made here first, never in
a copy.
