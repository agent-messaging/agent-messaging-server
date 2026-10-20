export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
// ── node vouch lifetime (§4.4) ───────────────────────────────────────────────
// A node→agent vouch is a signed claim with an expiry, and the registry treats
// the expiry as real: the reaper reclaims a registration whose vouch has lapsed
// (server/src/registry/reaper.ts, rule 2) and register() itself refuses an
// expired one (§9.7). So the vouch is not a fact an agent establishes once at
// startup — it is a lease, and an agent that stays up longer than the lease has
// to renew it. That is what the renewal loop in mesh.ts/node.ts does; these are
// its two numbers.

/** How long a minted node vouch is valid. Deliberately long: it is a lease on
 *  a durable registration, not a session token. The lease being long is only
 *  safe because something renews it — see VOUCH_RENEWAL_FRACTION. */
export const DEFAULT_VOUCH_TTL_MS = 30 * 24 * 60 * 60_000;
/** The vouch an UNDECLARED registration gets (§9.2): ephemerality is the
 *  default, durability is declared. An agent whose node profile states no
 *  availability_class made no retention promise, so its lease is short —
 *  generous for anything alive (renewal runs at two thirds of any TTL), and
 *  self-cleaning for dev runs, crashed spawns, and one-shot scripts, which
 *  age out in days instead of haunting discovery for a month. Declaring an
 *  availability class is the one-field statement of intent that earns the
 *  full lease above. */
export const EPHEMERAL_VOUCH_TTL_MS = 72 * 60 * 60_000;
/** How far into the vouch's life the SDK renews it. Two thirds: early enough
 *  that a whole missed cycle (a suspended laptop, an unreachable registry, a
 *  registry deploy) still leaves a third of the TTL to recover in, and late
 *  enough that renewal is rare rather than chatty. */
export const VOUCH_RENEWAL_FRACTION = 2 / 3;
/** Ceiling on how often the renewal loop looks at the clock. The loop compares
 *  wall-clock time against a stored deadline rather than sleeping until it, so
 *  a host that suspends for a week renews on the first tick after it wakes
 *  instead of waking a week late — which is the whole reason this is a periodic
 *  check and not one long timer. */
export const MAX_VOUCH_CHECK_INTERVAL_MS = 60 * 60_000;
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
export const DEFAULT_RECONNECT_TIME_WAIT_MS = 2_000;
export const DEFAULT_STREAM_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_CHUNK_TIMEOUT_MS = 30_000;

// ── freshness windows (§5.5 replay bound) ────────────────────────────────────
// A signature proves who wrote an envelope, never when — so a signed envelope
// is a bearer token for as long as anyone accepts it. Dedup-by-`id` (§5.5) only
// suppresses a *repeat*, and any bounded dedup memory forgets; without a
// freshness bound, an envelope replayed after the memory rolled over is
// indistinguishable from a fresh one. These windows are what make the dedup
// memory sufficient: nothing outside the window is accepted at all, so nothing
// outside it needs remembering.

/** How far in the FUTURE an inbound `ts` may sit (sender clock ahead). */
export const MAX_CLOCK_SKEW_AHEAD_MS = 5 * 60_000;
/** How far in the PAST a LIVE inbound `ts` may sit. Live request/reply is a
 *  matter of seconds; the slack is for badly-set sender clocks, not delivery. */
export const MAX_CLOCK_SKEW_BEHIND_MS = 10 * 60_000;
/** How far in the past a MAILBOX-drained `ts` may sit (§16.4). A buffered
 *  envelope is old by construction — that is the whole point of the buffer —
 *  so the live window cannot apply. The bound instead mirrors the buffer's own
 *  retention (`INBOX_BUFFER_MAX_AGE_MS`, 7 days by default, in
 *  server/src/registry/inbox-buffer.ts): a drained envelope older than the
 *  stream could ever have held it did not come from the stream honestly. */
export const MAX_MAILBOX_AGE_MS = 7 * 24 * 60 * 60_000;

/** How long one read of a Task's durable record (`mesh.task.get.<id>`, §7.4)
 *  may take before it counts as unanswered. */
export const TASK_RECORD_TIMEOUT_MS = 10_000;
/** After a deferred Task's update subscription goes live and the first record
 *  read finds it still running, when the one later read happens. It covers a
 *  terminal update the task manager had not stored yet at the first read. */
export const TASK_RECORD_RECHECK_MS = 1_500;
/** While awaitTask waits, the task record is read again at growing intervals
 *  (from TASK_RECORD_POLL_FIRST_MS, doubling) up to this one, so a terminal
 *  update lost in transit is still found. */
export const TASK_RECORD_POLL_MAX_MS = 30_000;
/** The first of those re-reads. Short, because the commonest miss is a
 *  deferred Task that finished just as it deferred: its terminal update went
 *  out before the requester's subscription was live, and the first record
 *  read came a moment before the task manager stored it (a deferral records
 *  `working` first, so the terminal is the second update it applies). */
export const TASK_RECORD_POLL_FIRST_MS = 250;

/** How many mailbox messages one §16.4 drain pull asks for. Bounds client-side
 *  buffering: a 25 MB backlog is drained in batches, never pulled into memory
 *  in one request. */
export const MAILBOX_DRAIN_BATCH = 100;
/** How long one drain pull waits to be filled, in ms (nats.js requires at least
 *  1000). It only ever elapses at the tail of a backlog, when the consumer has
 *  nothing left below the drain's bound to hand over; an *empty* backlog is
 *  recognised from consumer info before any pull is issued, so it never waits
 *  at all. */
export const MAILBOX_DRAIN_EXPIRES_MS = 5_000;

/** On an AMQP mesh a registered agent receives its inbox through its mailbox
 *  queue alone. A delivery that was not in the queue's backlog, was not handed
 *  out again, and was sent less than this long ago is a live delivery (§6.4a's
 *  accept, the live freshness window); anything older is treated as mail that
 *  waited, as a NATS agent's mailbox drain treats it. */
export const AMQP_MAILBOX_LIVE_WINDOW_MS = 60_000;
/** How many mailbox deliveries an AMQP agent works on at once: each is
 *  acknowledged when its dispatch finishes, so this bounds the dispatches in
 *  flight, as the broker's prefetch. */
export const AMQP_MAILBOX_PREFETCH = 128;

/** How often the §16.4 drain is re-run while an agent stays up.
 *
 *  The drain is bounded to the backlog present when it binds (which keeps live
 *  traffic on the live path instead of on whatever drain pass is running),
 *  and a bound on its own leaves the *tail* — everything the mailbox captured
 *  after the bind — sitting on the durable consumer unacked, forever. The
 *  consumer's cursor stays where the drain left it, the tail grows for the life
 *  of the process, and the next restart binds, sees all of it as backlog, and
 *  dispatches it: handlers re-run and answers go to senders' inboxes, with a
 *  fresh process's dedup memory unable to suppress any of it (§22.2: the memory
 *  does not survive a restart). Re-running the bounded drain is what keeps the
 *  cursor at the head, and each pass reads a fresh bound so the bound is not
 *  weakened.
 *
 *  **Why 60 seconds.** The number that matters is how much traffic can pile up
 *  in the tail between two passes, because a re-drain re-delivers everything the
 *  live path already handled and relies on the dedup memory to suppress it. That
 *  memory holds `MAX_SEEN_INBOX_IDS` (5,000) `(from, id)` pairs and evicts oldest
 *  first, and the tail is by construction the *newest* traffic — so every message
 *  in a tail of 5,000 or fewer is still remembered, and the re-drain acks it
 *  without dispatching. At 60s that takes a sustained 83 inbound messages per
 *  second, for a full minute, on one agent, to break — two orders of magnitude
 *  above an agent whose handler calls a model. On the other side, a pass costs
 *  one `STREAM.INFO` plus one `CONSUMER.INFO`, and a pull only when the tail is
 *  non-empty: two JetStream round trips a minute per agent, the same cadence the
 *  task pruner already runs at.
 *
 *  Lower it if an agent really is that busy (the residual is duplicate dispatch,
 *  not lost mail); raising it trades restart-replay risk for fewer round trips. */
export const DEFAULT_MAILBOX_DRAIN_INTERVAL_MS = 60_000;
/** Floor on a caller-configured drain interval. A pass is two JetStream requests
 *  plus a pull; without a floor, `0` is a busy loop against the broker. */
export const MIN_MAILBOX_DRAIN_INTERVAL_MS = 1_000;

/** How many `(from, id)` pairs the inbox dedup memory holds. Bounded on
 *  purpose (an unbounded set is a remote memory-exhaustion primitive); the
 *  freshness windows above are what make a bounded memory safe. */
export const MAX_SEEN_INBOX_IDS = 5_000;
/** Same, for event subscriptions (§22.1 names them as one of the inbound
 *  paths). A SEPARATE memory from the inbox's on purpose, mirroring the Rust
 *  SDK's `seen_events`: events arrive on subjects anyone may publish to, so a
 *  flood of them must not be able to evict the inbox memory's entries; the
 *  gap §22.2 warns about opens for the traffic nobody was watching. */
export const MAX_SEEN_EVENT_IDS = 5_000;
/** Same, per room (§7): rooms are many and small, so the per-room budget is. */
export const MAX_SEEN_ROOM_IDS = 1_000;
/** Cap on a room's observed roster. A roster grows from remote `join`
 *  messages, so an uncapped Set is a remote memory-exhaustion primitive. */
export const MAX_ROOM_ROSTER = 1_000;
/** Cap on a room's declared agenda (EXT-5 §8.5). It is signed into the
 *  descriptor every joiner verifies, and a meeting with more than a dozen
 *  planned phases has not been planned. */
export const MAX_ROOM_AGENDA = 12;

// ── inbound size cap (safety register 2.9) ───────────────────────────────────
// A message far larger than a message is not a message. The SDK used to bound
// nothing at all on the inbound path and relied on whatever the broker's
// `max_payload` happened to be — which is an unchosen vendor default (1 MB),
// three orders of magnitude above anything a real turn carries.

/** Cap on the sender text one inbound message may carry, in characters.
 *
 *  64 KiB, matching `MAX_INBOUND_CHARS` in mesh-adapter.mjs so the two layers
 *  agree on what "too big" means. The adapter's reasoning, preserved because it
 *  is the reason for this exact number rather than a rounder one: the fleet
 *  attendant passes the prompt as ONE argv element, Linux caps that at
 *  MAX_ARG_STRLEN (128 KiB), and the frame plus a room's rules go in front of
 *  the text — so anything much bigger was accepted and then silently never
 *  answered.
 *
 *  This is a bound on the sender's TEXT, not on the envelope: a sealed payload
 *  is measured as its base64 ciphertext, so the effective plaintext ceiling for
 *  a sealed message is roughly three quarters of this. The cap fires early
 *  rather than late, which is the safe direction. The envelope as a whole is the
 *  broker's `max_payload` to bound, and it should be set explicitly rather than
 *  inherited (SPEC §18.9). */
export const DEFAULT_MAX_INBOUND_CHARS = 64 * 1024;

/** How long a NON-terminal tracked task lives before it is pruned. Terminal
 *  tasks are pruned on their own (shorter) TTL; a responder that simply never
 *  finalizes otherwise leaks one entry per request, forever. Pruning drops
 *  local bookkeeping only — it cancels nothing. */
export const DEFAULT_TASK_MAX_LIFETIME_MS = 60 * 60_000;

// ── storefront proposals (§8.7, §8.12) ───────────────────────────────────────
// The owner edits the listing in the console; the agent fetches the edit and
// adopts it. The direction matters more than the cadence: nothing reaches into
// the host, the host comes and asks, which is what makes a web control panel
// acceptable for an agent running on somebody's own machine.

/** How often an agent asks whether its owner has edited its listing.
 *
 *  One minute, matching mesh-adapter's console sync, so the two implementations
 *  of this door feel the same to an owner watching the console: save, and it is
 *  live within a minute. The call is a signed POST that almost always comes
 *  back empty, so the cost of the cadence is one small request per agent per
 *  minute against the control plane, and only for agents that asked for it. */
export const DEFAULT_STOREFRONT_POLL_MS = 60_000;
/** Floor on a caller-configured poll interval. Without one, `0` is a busy loop
 *  against somebody else's HTTP service. */
export const MIN_STOREFRONT_POLL_MS = 5_000;
/** Deadline on one proposal request, stated rather than inherited for the same
 *  reason credential renewal states its own: `fetch` on Node has no overall
 *  timeout, and a stalled socket would hold the adopter's in-flight guard and
 *  stop the loop from ever retrying. No retry inside the call, because the loop
 *  is the retry and the proposal stays pending until it is acked. */
export const STOREFRONT_REQUEST_TIMEOUT_MS = 8_000;
