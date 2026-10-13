/**
 * The RabbitMQ binding's messaging and storage against a real RabbitMQ and a
 * real Postgres (step 9 of docs/agent-messaging-server-plan.md). Skips unless
 * both are named:
 *
 *   AMS_TEST_AMQP_URL       amqp://user:pass@127.0.0.1:5672/vhost (a vhost of its own)
 *   AMS_TEST_POSTGRES_URL   a throwaway database
 *
 * What it holds: subjects and wildcards with §14's meaning of `>`, queue
 * groups, request-reply with no-responders and timeouts, a reply address
 * passed through a relay, subscribe-then-publish ordering, the capture of
 * published messages into streams with deduplication on receipt, and an
 * agent's mailbox: a durable queue that holds mail while nobody consumes it,
 * follows a change of subject, empties on a purge and goes with the mailbox;
 * the kill switch's discard takes mail out of the queue as well as the record;
 * and a live request (the registry's probe) is never held for an agent that
 * is away.
 */
import type { Channel } from "amqplib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgSql, type Sql } from "../../src/storage/postgres/sql.js";
import { CapturePump } from "../../src/storage/rabbitmq/capture.js";
import { AmqpLink } from "../../src/storage/rabbitmq/link.js";
import { groupQueueName, RabbitMqMessaging } from "../../src/storage/rabbitmq/messaging.js";
import { RabbitMqStorage } from "../../src/storage/rabbitmq/storage.js";
import type { BusMessage, BusSubscription } from "../../src/storage/types.js";
import { InboxBuffer } from "../../src/registry/inbox-buffer.js";

const AMQP = process.env.AMS_TEST_AMQP_URL?.trim();
const PG = process.env.AMS_TEST_POSTGRES_URL?.trim();
const live = AMQP && PG ? describe : describe.skip;

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function collect(sub: BusSubscription, ms: number): Promise<BusMessage[]> {
  const got: BusMessage[] = [];
  const it = sub[Symbol.asyncIterator]();
  const end = Date.now() + ms;
  for (;;) {
    const left = end - Date.now();
    if (left <= 0) break;
    const r = await Promise.race([it.next(), sleep(left).then(() => null)]);
    if (!r || r.done) break;
    got.push(r.value);
  }
  return got;
}

live("RabbitMQ binding (live broker and database)", () => {
  let link: AmqpLink;
  let sql: Sql;
  let bus: RabbitMqMessaging;
  let storage: RabbitMqStorage;
  let pump: CapturePump;
  let admin: Channel;
  const run = Date.now().toString(36);

  beforeAll(async () => {
    sql = pgSql({ connectionString: PG!, max: 4 });
    await sql.query(
      "drop table if exists ams_keyed, ams_keyed_stores, ams_streams, ams_stream_messages, ams_stream_consumers, ams_account, ams_broker_sessions, ams_schema cascade",
    );
    link = new AmqpLink({ url: AMQP!, name: "storage-rabbitmq.test" });
    await link.open();
    admin = await link.channel();
    await admin.assertExchange("mesh", "topic", { durable: true });
    await admin.deleteQueue("ams.capture").catch(() => undefined);
    admin = await link.channel();
    bus = new RabbitMqMessaging(link);
    storage = new RabbitMqStorage(link, sql, bus, "./data/test-blobs");
    await storage.open();
    pump = new CapturePump(link, sql);
    await pump.start();
  });

  afterAll(async () => {
    await pump?.stop();
    await storage?.state.close();
    await link?.close();
    await sql?.close();
  });

  it("delivers on subjects, with `*` one word and `>` one or more", async () => {
    const star = bus.subscribe(`t${run}.a.*`);
    const rest = bus.subscribe(`t${run}.a.>`);
    for (const s of [`t${run}.a`, `t${run}.a.b`, `t${run}.a.b.c`]) bus.publish(s, te.encode(s));
    const [gotStar, gotRest] = await Promise.all([collect(star, 800), collect(rest, 800)]);
    expect(gotStar.map((m) => m.subject)).toEqual([`t${run}.a.b`]);
    expect(gotRest.map((m) => m.subject)).toEqual([`t${run}.a.b`, `t${run}.a.b.c`]);
    star.unsubscribe();
    rest.unsubscribe();
  });

  it("shares a queue group's messages among its members", async () => {
    const a = bus.subscribe(`g${run}.x`, { queue: "workers" });
    const b = bus.subscribe(`g${run}.x`, { queue: "workers" });
    for (let i = 0; i < 10; i++) bus.publish(`g${run}.x`, te.encode(String(i)));
    const [ga, gb] = await Promise.all([collect(a, 800), collect(b, 800)]);
    expect(ga.length + gb.length).toBe(10);
    expect(ga.length).toBeGreaterThan(0);
    expect(gb.length).toBeGreaterThan(0);
    a.unsubscribe();
    b.unsubscribe();
  });

  it("never delivers a message put straight into a subscription's queue by name", async () => {
    // A queue group's queue has a name anyone can work out. Bound to `>`, its
    // routing key alone would pass the subject check, so the exchange is what
    // tells a message sent on a subject from one put into the queue directly.
    const group = `direct${run}`;
    const sub = bus.subscribe(">", { queue: group });
    await bus.flush();
    const queue = groupQueueName(group, ">");
    admin.sendToQueue(queue, Buffer.from("smuggled"));
    bus.publish(`d${run}.proper`, te.encode("proper"));
    const got = await collect(sub, 1500);
    const mine = got.filter((m) => m.subject === `d${run}.proper` || td.decode(m.data) === "smuggled");
    expect(mine.map((m) => td.decode(m.data))).toEqual(["proper"]);
    sub.unsubscribe();
  });

  it("answers a request, says at once when nobody listens, and times out", async () => {
    const svc = bus.subscribe(`r${run}.echo`);
    void (async () => {
      for await (const m of svc) m.respond(te.encode(`echo:${td.decode(m.data)}`));
    })();
    const answer = await bus.request(`r${run}.echo`, te.encode("hi"), { timeout: 3000 });
    expect(td.decode(answer.data)).toBe("echo:hi");
    const t0 = Date.now();
    await expect(bus.request(`r${run}.nobody`, te.encode("x"), { timeout: 5000 })).rejects.toMatchObject({ code: "503" });
    expect(Date.now() - t0).toBeLessThan(2000);
    const silent = bus.subscribe(`r${run}.silent`);
    await expect(bus.request(`r${run}.silent`, te.encode("x"), { timeout: 400 })).rejects.toMatchObject({ code: "TIMEOUT" });
    svc.unsubscribe();
    silent.unsubscribe();
  });

  it("carries a reply address through a relay, as the admission guard does", async () => {
    // The agent answers whatever reaches its guarded subject on the reply.
    const agent = bus.subscribe(`rl${run}.guarded`);
    void (async () => {
      for await (const m of agent) m.respond(te.encode("from-agent"));
    })();
    // The relay takes requests on the public subject and forwards them.
    const relay = bus.subscribe(`rl${run}.public`);
    void (async () => {
      for await (const m of relay) {
        const inbox = bus.newInbox();
        const back = bus.subscribe(inbox);
        bus.publish(`rl${run}.guarded`, m.data, { reply: inbox });
        for await (const r of back) {
          m.respond(r.data);
          break;
        }
        back.unsubscribe();
      }
    })();
    const answer = await bus.request(`rl${run}.public`, te.encode("q"), { timeout: 3000 });
    expect(td.decode(answer.data)).toBe("from-agent");
    agent.unsubscribe();
    relay.unsubscribe();
  });

  it("captures published messages into a stream, dropping a repeat of one envelope", async () => {
    const events = storage.stream("MESH_EVENTS");
    expect(await events.ensure()).toBe(true);
    const env = JSON.stringify({ id: `e-${run}`, from: "UFROM", type: "event", payload: {} });
    bus.publish(`mesh.event.c${run}.happened`, te.encode(env));
    bus.publish(`mesh.event.c${run}.happened`, te.encode(env)); // a redelivered publish
    bus.publish(`mesh.event.c${run}`, te.encode("not under mesh.event.c.>")); // still mesh.event.>
    bus.publish(`mesh.other.c${run}`, te.encode("not an event"));
    let got: string[] = [];
    for (let i = 0; i < 30 && got.length < 2; i++) {
      await sleep(100);
      got = [];
      for await (const m of events.readFrom(1, { max: 100, waitMs: 1000 })) if (m.subject.includes(run)) got.push(m.subject);
    }
    expect(got).toEqual([`mesh.event.c${run}.happened`, `mesh.event.c${run}`]);
  });

  it("keeps an agent's mail in its mailbox queue while nobody consumes it", async () => {
    const agent = `A${run.toUpperCase()}`;
    const inbox = `mesh.agent.${agent}.inbox`;
    const box = storage.streams("MESH_INBOX_<agent>").member(agent);
    await box.create({ subjects: [inbox], maxAgeMs: 7 * 86_400_000, maxBytes: 25 * 1024 * 1024, discard: "old", silent: true });
    bus.publish(inbox, te.encode(JSON.stringify({ id: "m1", from: "USENDER", type: "request" })));
    bus.publish(`${inbox}.guarded`, te.encode("not yet captured"));
    await bus.flush();
    await sleep(500);
    expect((await admin.checkQueue(`MESH_INBOX_${agent}`)).messageCount).toBe(1);
    expect((await box.info())!.messages).toBe(1); // the record the audit backstop reads
    expect(await box.consumerState(`inbox_${agent}`)).toMatchObject({ pending: 1 });

    // Guarding the agent moves both to the guarded subject.
    await box.reconfigure((await box.info())!, { subjects: [`${inbox}.guarded`] });
    await box.purge();
    bus.publish(inbox, te.encode("raw, now the relay's"));
    bus.publish(`${inbox}.guarded`, te.encode(JSON.stringify({ id: "m2", from: "USENDER", type: "request" })));
    await bus.flush();
    await sleep(500);
    const q = await admin.checkQueue(`MESH_INBOX_${agent}`);
    expect(q.messageCount).toBe(1);
    const m = await admin.get(`MESH_INBOX_${agent}`, { noAck: true });
    expect(m && JSON.parse(m.content.toString()).id).toBe("m2");

    await box.destroy();
    await expect(admin.checkQueue(`MESH_INBOX_${agent}`)).rejects.toThrow(/NOT_FOUND|404/);
    admin = await link.channel(); // the failed check closed that channel
  });

  it("discards what arrived since a time from the mailbox queue as well as its record", async () => {
    const agent = `D${run.toUpperCase()}`;
    const inbox = `mesh.agent.${agent}.inbox`;
    const queue = `MESH_INBOX_${agent}`;
    const box = storage.streams("MESH_INBOX_<agent>").member(agent);
    await box.create({ subjects: [inbox], maxAgeMs: 7 * 86_400_000, maxBytes: 25 * 1024 * 1024, discard: "old", silent: true });
    const msg = (id: string) => te.encode(JSON.stringify({ id, from: "USENDER", type: "request" }));
    bus.publish(inbox, msg("before"));
    await bus.flush();
    await sleep(600);
    const since = Date.now();
    await sleep(50);
    bus.publish(inbox, msg("during-1"));
    bus.publish(inbox, msg("during-2"));
    await bus.flush();
    await sleep(600);
    expect((await admin.checkQueue(queue)).messageCount).toBe(3);

    const discarded = await new InboxBuffer(storage).discard(agent, since);
    expect(discarded).toBe(2);
    expect((await box.info())!.messages).toBe(1);
    // The queue is what the agent's node consumes: it keeps only the older mail.
    expect((await admin.checkQueue(queue)).messageCount).toBe(1);
    const kept = await admin.get(queue, { noAck: true });
    expect(kept && JSON.parse(kept.content.toString()).id).toBe("before");
    await box.destroy();
  });

  it("holds no live request for a receiver that is away, and delivers it to one consuming the mailbox", async () => {
    const agent = `P${run.toUpperCase()}`;
    const inbox = `mesh.agent.${agent}.inbox`;
    const queue = `MESH_INBOX_${agent}`;
    const box = storage.streams("MESH_INBOX_<agent>").member(agent);
    await box.create({ subjects: [inbox], maxAgeMs: 7 * 86_400_000, maxBytes: 25 * 1024 * 1024, discard: "old", silent: true });
    const probe = te.encode(JSON.stringify({ id: `probe-${run}`, from: "UREGISTRY", type: "request", payload: { offering: "__registry_probe__" } }));

    // Nobody consumes the mailbox: the probe times out, as on NATS, and nothing keeps it.
    await expect(bus.request(inbox, probe, { timeout: 500, live: true })).rejects.toMatchObject({ code: "TIMEOUT" });
    await sleep(500);
    expect((await admin.checkQueue(queue)).messageCount).toBe(0);
    expect((await box.info())!.messages).toBe(0);

    // The agent's node consuming its mailbox answers it on the reply address.
    const node = await link.channel();
    await node.consume(queue, (m) => {
      if (!m) return;
      node.publish("", m.properties.replyTo as string, Buffer.from("alive"), { correlationId: m.properties.correlationId as string });
      node.ack(m);
    });
    const answer = await bus.request(inbox, probe, { timeout: 3000, live: true });
    expect(td.decode(answer.data)).toBe("alive");
    await node.close();
    await box.destroy();
  });
});
