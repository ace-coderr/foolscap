-- schema.sql — Notary, after the pivot from watching to witnessing.
--
-- TWO TABLES. `records` is what was brought to Notary and verified; `anchors`
-- is the daily Merkle root over them. Nothing else, because nothing else has a
-- job any more.
--
-- WHAT WENT, AND WHY IT IS NOT COMING BACK.
--
-- Notary used to crawl. It followed a list of rooms, read every message that
-- went past, verified what it could and stored it — and that model died on
-- arithmetic, not on taste. The network was minting 587,324 new (did, room)
-- pairs a day against a 500 MB database, and the traffic had collapsed to 1.49
-- messages per pair: almost every message was the only message its identity
-- ever sent. No per-identity index survives that. Not a summary tier, not a
-- retention window, not a bigger plan — a tier costing a kilobyte a pair still
-- wants 570 MB a day, and the growth curve was accelerating.
--
-- So four tables went with the crawl:
--
--   summaries        one row per (did, room), the compression of crawled
--                    traffic. There is no crawled traffic to compress.
--   summary_anchors  roots over that tier.
--   cursors          where the mirror had read up to in each room.
--   gaps             holes in crawl coverage. Notary no longer has coverage to
--                    have holes in; it has submissions, and a submission is
--                    either witnessed or was never made.
--
-- And with them the `sighting`/`activity_day` sampling, which existed so a
-- crawled room could be kept at two rows per DID per day, and `source`, which
-- distinguished 'submitted' from 'mirrored' when both existed. Everything is
-- submitted now. A column that can only hold one value is a column that is
-- lying about being a choice.
--
-- THE OLD DATABASE IS NOT MIGRATED INTO THIS ONE. It is read-only at 1578 MB
-- against a 500 MB cap and cannot be shrunk — TRUNCATE is a write and is
-- refused like any other. This schema is for a fresh project. The anchors that
-- were published before the pivot remain true and their roots remain in
-- technocore; what is gone is the records they commit to, so no proof can be
-- built against them ever again. The page says exactly that.

-- ---------------------------------------------------------------------------
-- records — what was brought to Notary, verified, and stamped with its clock
-- ---------------------------------------------------------------------------

create table if not exists records (
  id           bigserial primary key,
  did          text        not null,
  room         text        not null,
  nonce        numeric(20,0) not null,
  sig          text        not null,
  text         text        not null,

  -- NOTARY'S CLOCK, and the only timestamp on the table.
  --
  -- The crawling schema also kept source_ts and source_seq — the room's own
  -- claim about when a message was posted — because a mirrored record was
  -- witnessed long after the fact and the difference was the honest part. A
  -- submitted record has no such gap: the agent posts it and Notary stamps it,
  -- seconds apart, and the stamp is a thing Notary watched happen rather than a
  -- number it was handed. There is nothing left to disagree with, so there is
  -- nothing left to store.
  captured_at  timestamptz not null default now(),

  -- The day captured_at falls in, UTC. This is what the daily anchor is over,
  -- and it is a stored column rather than an expression so the anchor's leaf
  -- set cannot drift with anyone's session timezone.
  day          date        not null
);

-- IDEMPOTENT ON (did, room, nonce), which is what makes a retried /capture
-- return the original rather than a second copy. The nonce is the agent's own
-- replay guard and Technocore already refuses a repeat, so this index agrees
-- with the network rather than inventing a second rule.
create unique index if not exists records_did_room_nonce_key
  on records (did, room, nonce);

-- The one question the page asks of this table: what has Notary witnessed for
-- this key, oldest first.
create index if not exists records_did_captured_at_idx on records (did, captured_at);

-- The anchor builder's scan: every record of one day.
create index if not exists records_day_idx on records (day);

-- ---------------------------------------------------------------------------
-- anchors — the daily Merkle root, and whether anyone has witnessed it
-- ---------------------------------------------------------------------------

create table if not exists anchors (
  day            date primary key,
  root           text,
  record_count   int,
  published_seq  bigint,
  published_at   timestamptz,
  first_capture  timestamptz,
  last_capture   timestamptz
);

-- A published row is final.
--
-- This started as a fix for one incident: a verification run rebuilt an
-- already-published day's anchor over the records that survived pruning and
-- wrote the result on top of it. root and record_count were recoverable from
-- the published message; the capture window was not, because the message
-- carrying it had rotated out of the room by the time anyone noticed.
--
-- Pruning is gone, so the specific cause cannot recur. The guard stays because
-- it was never really about pruning: a root that has been handed to the network
-- is a promise, and a promise you can still edit is not one.
create or replace function anchors_published_is_final() returns trigger as $$
begin
  if old.published_seq is not null and (
       new.root is distinct from old.root
    or new.record_count is distinct from old.record_count
    or new.published_seq is distinct from old.published_seq
  ) then
    raise exception 'anchor for % is published and cannot be rewritten', old.day
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists anchors_no_rewrite on anchors;
create trigger anchors_no_rewrite
  before update on anchors
  for each row execute function anchors_published_is_final();
