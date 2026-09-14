-- Foolscap Notary — schema.
--
-- Safe to run more than once.
--
-- The one column worth staring at is `nonce`. It is numeric(20,0), never bigint
-- and never anything that could reach this database as a JSON number: nonces
-- exceed 2^53, and a nonce that has been through a double is a nonce that no
-- longer reproduces the canonical string `<room>|<nonce>|<text>`. A record whose
-- signature cannot be re-verified is worth nothing here, because re-verification
-- by a stranger is the entire product.

create table if not exists records (
  id           bigserial primary key,
  did          text        not null,
  room         text        not null,
  nonce        numeric(20,0) not null,
  sig          text        not null,
  text         text        not null,
  captured_at  timestamptz not null default now(),
  day          date        not null,
  source       text        not null check (source in ('submitted', 'mirrored')),

  -- The room's own timestamp for the message, when the read API gave us one.
  -- captured_at is when Notary saw it, which for a mirrored record is later —
  -- sometimes much later — than when it was posted. Keeping both is the honest
  -- thing: only one of them is Notary's to vouch for.
  source_ts    timestamptz,
  source_seq   bigint
);

-- Sampling, for rooms kept under the 'sightings' policy.
--
-- null        a full record: every message from that room is stored.
-- 'first'     the earliest message that DID posted in that room that day.
-- 'last'      the most recent, and it is replaced as the day goes on.
--
-- `day` is the capture day and belongs to the daily anchor. `activity_day` is
-- the day the message was POSTED, which is what a sighting is about: a backfill
-- reading three days of ring history in one minute must still produce three
-- days of sightings.
alter table records add column if not exists sighting     text;
alter table records add column if not exists activity_day date;

alter table records drop constraint if exists records_did_room_nonce_key;

-- Full records stay idempotent on (did, room, nonce), which is what makes a
-- retried /capture return the original rather than a second copy.
create unique index if not exists records_full_key
  on records (did, room, nonce) where sighting is null;

-- Sampled rooms hold at most two rows per DID per day of activity.
create unique index if not exists records_sighting_key
  on records (did, room, activity_day, sighting) where sighting is not null;

alter table records drop constraint if exists records_sighting_check;
alter table records add constraint records_sighting_check
  check (sighting is null or (sighting in ('first', 'last') and activity_day is not null));

create index if not exists records_did_captured_at_idx on records (did, captured_at);
create index if not exists records_day_idx on records (day);
create index if not exists records_room_seq_idx on records (room, source_seq);

create table if not exists anchors (
  day            date primary key,
  root           text,
  record_count   int,
  published_seq  bigint,
  published_at   timestamptz,
  first_capture  timestamptz,
  last_capture   timestamptz
);

-- Holes in the archive, recorded rather than hidden.
--
-- TWO OF THESE ARE LOSS AND ONE IS NOT, and conflating them is the mistake this
-- comment exists to prevent. It was made: the coverage endpoint summed `missing`
-- across every kind, so history that predated Notary was reported as messages
-- Notary had lost, and the headline overstated the loss by a factor of forty.
--
-- 'missed'      lines rotated past while Notary was following the room — it was
--               reading, and the ring outran it. LOSS.
-- 'downtime'    lines that went past between the last message Notary stored for
--               a room and where the ring began when it next looked. Notary was
--               responsible for the room and was not running. LOSS.
-- 'regenerated' the room was deleted and recreated; sequence numbers restarted.
-- 'rotated'     what the ring had already dropped when Notary FIRST looked at a
--               room. It marks the start of coverage and is NOT loss: nobody
--               could have captured it, and no one can say how much there was.
--
--               These rows must never be summed. Each one re-asserts a whole
--               room from seq 1, and one is written every time the mirror
--               restarts — three kibble rows inside six hours each claimed the
--               room's entire 6.4M-message history. The row is a marker that a
--               room began mid-ring, and that is all it can support.
--
-- An archive that quietly has holes is worse than no archive, because people
-- would draw conclusions from absence. Every answer this database gives about a
-- DID has to be readable against this table.
create table if not exists gaps (
  id           bigserial primary key,
  room         text not null,
  kind         text not null,
  missing      integer,
  expected_seq bigint,
  first_seq    bigint,
  generation   integer,
  noticed_at   timestamptz not null default now(),

  -- How many of `missing` a later re-export got back. A poll returns only the
  -- newest messages after the cursor, so a busy room is routinely skipped past
  -- rather than followed; /export still holds those messages until the ring
  -- drops them. recovered < missing means the archive really is short that many.
  recovered    integer not null default 0
);

alter table gaps add column if not exists recovered integer not null default 0;

-- Stated as an alter rather than inline on the create, because 'downtime' is
-- newer than the table and an existing database has the three-value constraint
-- on it. Dropping and re-adding is idempotent; leaving it would make every
-- downtime gap fail to insert on a deployment that had not migrated.
alter table gaps drop constraint if exists gaps_kind_check;
alter table gaps add constraint gaps_kind_check
  check (kind in ('missed', 'downtime', 'regenerated', 'rotated'));

create index if not exists gaps_room_noticed_idx on gaps (room, noticed_at);

-- The coverage endpoint asks for the largest holes rather than all of them, and
-- there are already a thousand rows.
create index if not exists gaps_kind_missing_idx on gaps (kind, missing desc);
