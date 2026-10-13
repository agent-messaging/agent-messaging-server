/**
 * The Postgres schema of the RabbitMQ binding's state (step 9 of
 * docs/agent-messaging-server-plan.md).
 *
 * Every statement is idempotent (`if not exists`, `create or replace`), so the
 * server applies the whole schema at every start and first-run setup writes
 * the same text to a file for an operator who wants to read it first. Tables
 * are prefixed `ams_` so the schema can share a database.
 *
 * Keyed records: one row per key, holding its newest revision. A delete or a
 * purge leaves a marker row (operation DEL or PURGE, empty value), so a watch
 * sees the removal, as it does on JetStream. Revisions are counted per store
 * in `ams_keyed_stores`, under that row's lock, so they only grow and a watch
 * that reads "everything after revision N" never misses a write that commits
 * late. A value with a time to live carries `expires_at` and reads as absent
 * once it has passed.
 *
 * Streams: one row per stream in `ams_streams` (its subjects and limits, and
 * the counters a trigger keeps), and its messages in `ams_stream_messages` by
 * sequence. `ams_stream_append` applies the limits and the deduplication
 * window in the same call that writes the message. A durable consumer's place
 * is `ams_stream_consumers`: the floor below which everything is acknowledged,
 * and the acknowledged sequences above it.
 *
 * The account (the key chain's account JWT, which carries the revocations the
 * broker refuses) and the broker sessions (what each connected node may do)
 * are the RabbitMQ binding's identity tables (storage/rabbitmq/broker-auth.ts).
 */
import type { Sql } from "./sql.js";

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
-- Agent Messaging Server, RabbitMQ binding: the state Postgres holds. Schema ${SCHEMA_VERSION}.

create table if not exists ams_schema (
  version integer primary key,
  applied timestamptz not null default now()
);

-- Keyed records -------------------------------------------------------------

create table if not exists ams_keyed_stores (
  store text primary key,
  last_revision bigint not null default 0
);

create table if not exists ams_keyed (
  store text not null,
  key text not null,
  value bytea not null,
  revision bigint not null,
  created timestamptz not null,
  operation text not null,
  expires_at timestamptz,
  primary key (store, key)
);
create index if not exists ams_keyed_by_revision on ams_keyed (store, revision);
create index if not exists ams_keyed_expiring on ams_keyed (expires_at) where expires_at is not null;

-- p_mode: 'any' writes unconditionally; 'expect' writes only when the key's
-- newest revision is p_expect (0: the key holds nothing); 'create' writes only
-- when the key holds no live value. A lost compare-and-set raises
-- 'wrong last sequence: N', the words JetStream uses.
create or replace function ams_keyed_write(
  p_store text, p_key text, p_value bytea, p_op text, p_mode text, p_expect bigint, p_ttl_ms bigint
) returns bigint language plpgsql as $$
declare
  cur_rev bigint;
  cur_op text;
  cur_exp timestamptz;
  next_rev bigint;
begin
  insert into ams_keyed_stores (store) values (p_store) on conflict do nothing;
  select last_revision into next_rev from ams_keyed_stores where store = p_store for update;
  select revision, operation, expires_at into cur_rev, cur_op, cur_exp
    from ams_keyed where store = p_store and key = p_key;
  if cur_exp is not null and cur_exp <= now() then
    cur_rev := null;
    cur_op := null;
  end if;
  if p_mode = 'expect' and coalesce(cur_rev, 0) <> p_expect then
    raise exception 'wrong last sequence: %', coalesce(cur_rev, 0);
  end if;
  if p_mode = 'create' and cur_op = 'PUT' then
    raise exception 'wrong last sequence: %', cur_rev;
  end if;
  next_rev := next_rev + 1;
  update ams_keyed_stores set last_revision = next_rev where store = p_store;
  insert into ams_keyed (store, key, value, revision, created, operation, expires_at)
    values (
      p_store, p_key, coalesce(p_value, '\\x'::bytea), next_rev, clock_timestamp(), p_op,
      case when p_ttl_ms is not null then clock_timestamp() + p_ttl_ms * interval '1 millisecond' end
    )
    on conflict (store, key) do update set
      value = excluded.value, revision = excluded.revision, created = excluded.created,
      operation = excluded.operation, expires_at = excluded.expires_at;
  perform pg_notify('ams_keyed', p_store);
  return next_rev;
end $$;

-- Streams -------------------------------------------------------------------

create table if not exists ams_streams (
  name text primary key,
  family text,
  member text,
  subjects text[] not null default '{}',
  max_age_ms bigint,
  max_bytes bigint,
  max_msgs bigint,
  discard text not null default 'old',
  dedup_window_ms bigint not null default 120000,
  last_seq bigint not null default 0,
  messages bigint not null default 0,
  bytes bigint not null default 0,
  created timestamptz not null default now()
);
create index if not exists ams_streams_by_family on ams_streams (family);

create table if not exists ams_stream_messages (
  stream text not null,
  seq bigint not null,
  subject text not null,
  data bytea not null,
  time timestamptz not null,
  msg_id text,
  primary key (stream, seq)
);
create index if not exists ams_stream_messages_by_id on ams_stream_messages (stream, msg_id) where msg_id is not null;
create index if not exists ams_stream_messages_by_time on ams_stream_messages (stream, time);

create or replace function ams_stream_count() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update ams_streams set messages = messages + 1, bytes = bytes + length(new.data) where name = new.stream;
    return new;
  else
    update ams_streams set messages = messages - 1, bytes = bytes - length(old.data) where name = old.stream;
    return old;
  end if;
end $$;
drop trigger if exists ams_stream_count on ams_stream_messages;
create trigger ams_stream_count after insert or delete on ams_stream_messages
  for each row execute function ams_stream_count();

-- Write one message and return its sequence. A message id seen inside the
-- stream's window returns the sequence it was written under, and writes
-- nothing. A stream that discards new messages refuses when full.
create or replace function ams_stream_append(p_stream text, p_subject text, p_data bytea, p_msg_id text)
returns bigint language plpgsql as $$
declare
  s ams_streams%rowtype;
  dup bigint;
  next_seq bigint;
  oldest bigint;
begin
  select * into s from ams_streams where name = p_stream for update;
  if not found then
    raise exception 'stream not found: %', p_stream;
  end if;
  if p_msg_id is not null then
    select seq into dup from ams_stream_messages
      where stream = p_stream and msg_id = p_msg_id
        and time > clock_timestamp() - s.dedup_window_ms * interval '1 millisecond'
      limit 1;
    if dup is not null then
      return dup;
    end if;
  end if;
  if coalesce(s.max_age_ms, 0) > 0 then
    delete from ams_stream_messages
      where stream = p_stream and time < clock_timestamp() - s.max_age_ms * interval '1 millisecond';
    select * into s from ams_streams where name = p_stream;
  end if;
  if s.discard = 'new' then
    if (coalesce(s.max_msgs, 0) > 0 and s.messages >= s.max_msgs)
       or (coalesce(s.max_bytes, 0) > 0 and s.bytes + length(p_data) > s.max_bytes) then
      raise exception 'maximum messages exceeded';
    end if;
  end if;
  next_seq := s.last_seq + 1;
  update ams_streams set last_seq = next_seq where name = p_stream;
  insert into ams_stream_messages (stream, seq, subject, data, time, msg_id)
    values (p_stream, next_seq, p_subject, p_data, clock_timestamp(), p_msg_id);
  if s.discard = 'old' then
    if coalesce(s.max_msgs, 0) > 0 then
      delete from ams_stream_messages where stream = p_stream and seq <= next_seq - s.max_msgs;
    end if;
    if coalesce(s.max_bytes, 0) > 0 then
      loop
        select bytes into s.bytes from ams_streams where name = p_stream;
        exit when s.bytes <= s.max_bytes;
        select min(seq) into oldest from ams_stream_messages where stream = p_stream;
        exit when oldest is null or oldest = next_seq;
        delete from ams_stream_messages where stream = p_stream and seq = oldest;
      end loop;
    end if;
  end if;
  perform pg_notify('ams_stream', p_stream);
  return next_seq;
end $$;

create table if not exists ams_stream_consumers (
  stream text not null,
  durable text not null,
  filter text,
  ack_floor bigint not null default 0,
  acked bigint[] not null default '{}',
  created timestamptz not null default now(),
  primary key (stream, durable)
);

-- Identity (the RabbitMQ binding's key chain side) ---------------------------

-- The account JWT the key chain signs, holding the revocations and signing
-- keys the broker check reads: the binding's resolver.
create table if not exists ams_account (
  account text primary key,
  jwt text not null,
  updated timestamptz not null default now()
);

-- What each connected node may do: the claims of the newest credential it
-- connected with, so the broker's per-operation checks (which carry only the
-- user name) can be answered.
create table if not exists ams_broker_sessions (
  username text primary key,
  claims jsonb not null,
  iat bigint not null,
  updated timestamptz not null default now()
);

insert into ams_schema (version) values (${SCHEMA_VERSION}) on conflict do nothing;
`;

/** Any number that is ours: the advisory lock two processes starting at once
 *  take, so they do not replace the same function at the same moment. */
const SCHEMA_LOCK = 7_268_001;

/** Apply the schema. Safe to run at every start. The whole text runs as one
 *  implicit transaction, so a failure leaves nothing half made. */
export async function applySchema(sql: Sql): Promise<void> {
  await sql.session(async (q) => {
    await q("select pg_advisory_lock($1)", [SCHEMA_LOCK]);
    try {
      await q(SCHEMA_SQL);
    } finally {
      await q("select pg_advisory_unlock($1)", [SCHEMA_LOCK]);
    }
  });
}
