# Scenario: a laptop for a new employee

A business scenario that runs against the Agent Messaging Server on either
broker, with this repository's SDK. Where the examples show one feature each,
this runs a whole purchase across two companies and checks the server behaves
the way an outside user expects: synchronous and asynchronous calls, long
waits, agents going offline, separate identities, and refusals.

## The scenario

Two companies (tenants) on one mesh, four agents, four identities.

| Agent | Company | Does | How it is called |
|---|---|---|---|
| Requester (onboarding) | Acme, internal | Finds the price for the laptop | calls the others |
| Approver (procurement) | Acme, internal | Approves, then places the order; the only identity that can buy | asynchronous (a deferred task, §7.0) |
| Pricing agent | Laptop vendor, external | Quotes the cheapest laptop that meets the requirements | synchronous request and reply |
| Order agent | Laptop vendor, external | Takes the order, reports status, says when it ships | accepts at once, reports later |

1. **Quote, synchronous.** The requester asks the pricing agent and waits up to `QUOTE_TIMEOUT_MS`.
2. **Approval, asynchronous.** The requester sends the quote to the approver and gets a task id at once; the decision arrives as the task's result. Above `AUTO_APPROVE_LIMIT_USD` it waits `APPROVAL_DELAY_MS` for a manager.
3. **Order.** The approver orders with its own identity. The order agent answers at once with an order id and fulfils it in the background.
4. **Status.** `order_status` answers at any time: accepted, processing, shipped or cancelled.
5. **Shipment report.** `SHIP_DELAY_MS` after the order, the order agent sends a shipment notice to the approver, which passes it to the requester. A notice to an agent that is offline waits in its mailbox and arrives when it is back.

## The tests

| | |
|---|---|
| T1 | Happy path end to end, with the audit log showing each identity |
| T2 | No laptop meets the requirements |
| T3 | Pricing agent offline: the synchronous call fails within its timeout |
| T4a, T4b | Over budget; the manager declines. No order either way |
| T5 | Above the limit: waits for the manager, then orders |
| T6, T6b–d | Identity separation: the requester cannot buy, an outsider cannot ask for approval, only the buyer reads status, only the vendor sends shipment notices |
| T7a–c | A message with a forged sender, or changed after signing, is dropped; the untouched control is accepted |
| T8 | Status at every stage |
| T9, T9b | Approver, then requester, offline at shipment: the notice waits and arrives on return |
| T10 | The same order twice: one order |
| T11 | Quote expired: refused by the approver and by the vendor |
| T12, T12b | Cancel before shipment; cannot cancel after |
| T13 | The vendor's door: describe, knock, admit, block |
| T14 | Kill switch: the order agent is revoked mid-purchase |
| T15 | The requester lowers the quoted price: the vendor refuses the order |
| timing | A deferred task's result reaches the requester however soon after deferral the handler finishes |

## Running it

Start one of the Compose setups first (`deploy/compose/nats` or
`deploy/compose/rabbitmq`, `docker compose up -d`), then:

```sh
cd sdk-typescript && npm ci && npm run build && cd ..
cd scenarios/laptop-purchase && npm ci
node run.mjs nats                                   # or: node run.mjs rabbitmq
node run.mjs nats tests/laptop-happy.test.ts        # one file
```

`run.mjs` copies the admin token out of the Compose volume (never printing
it), as `examples/run.mjs` does. Each test makes its own tenants and agents
with a suffix, so the scenario can run again and again on one mesh.

## Settings

Defaults are in `config.json`. Each can be overridden from the environment:

| Variable | Default | What it is |
|---|---|---|
| `SHIP_DELAY_MS` | 8000 | From order to shipment |
| `APPROVAL_DELAY_MS` | 1500 | How long the manager takes, above the limit |
| `APPROVAL_REVIEW_MS` | 500 | The approver's own check before any decision |
| `QUOTE_TIMEOUT_MS` | 5000 | How long the requester waits for a quote |
| `QUOTE_TTL_MS` | 60000 | How long a quote stays valid |
| `AUTO_APPROVE_LIMIT_USD` | 2000 | Approved without a manager at or below this |
| `OFFLINE_WINDOW_MS` | 4000 | How long an agent stays offline in T9 and T9b |
| `TEST_TIMEOUT_MS` | 180000 | Per test; raise it with long delays |

A two-hour shipment:

```sh
SHIP_DELAY_MS=7200000 OFFLINE_WINDOW_MS=600000 TEST_TIMEOUT_MS=9000000 node run.mjs nats
```

## Pipeline

`.github/workflows/scenarios.yml` brings each broker's mesh up from this
commit, then runs the scenario on pull requests that touch the server, the
SDK or the scenario. It also runs nightly with a two-hour shipment, and by
hand with your own delays.

## A fixed issue

On RabbitMQ, a deferred task whose handler finished about 50 ms after it
deferred could lose its result: `awaitTask` timed out. The final update was
published before the requester's subscription was bound, and nothing
recovered it from the task record. It failed every time on server 0.1.3 and
some of the time on 0.2.0. SDK 0.61.1 (with server 0.2.1) fixes it: the
requester waits until its subscription is live before it acts on `working`,
and reads the task record for anything published before.
`tests/deferred-task-timing.test.ts` reproduces the old failure, and the
workflow now requires it on both brokers. The approver still spends
`APPROVAL_REVIEW_MS` on its check; set it to 0 to run the scenario at full
speed.
