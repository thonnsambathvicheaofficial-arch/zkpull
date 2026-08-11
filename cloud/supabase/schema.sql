-- ZK Report Puller — Supabase schema.  Run once in the Supabase SQL editor.

create extension if not exists pgcrypto;

-- Devices. The background puller reads this list and pulls each 'pull' device.
create table if not exists devices (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  type            text not null default 'pull',      -- 'pull' | 'adms'
  ip              text,
  port            integer not null default 4370,
  serial          text,
  created_at      timestamptz not null default now(),
  last_pull_at    timestamptz,   -- when the puller last attempted this device (success or fail)
  last_pull_ok    boolean,       -- result of that attempt
  last_pull_error text,          -- error message when last_pull_ok = false
  last_pull_count integer        -- new punches pushed on that attempt
);
-- Heartbeat columns, written after every pull attempt — this is how the web UI
-- knows the puller is actually alive and reaching Supabase.
alter table devices add column if not exists last_pull_at    timestamptz;
alter table devices add column if not exists last_pull_ok    boolean;
alter table devices add column if not exists last_pull_error text;
alter table devices add column if not exists last_pull_count integer;

-- Public endpoint for public_host / public_port: router WAN IP + port forward to the device's internal IP/port
-- ip/port above stay the device's LAN address (informational)
-- these are the externally-reachable address /api/cron/pull actually dials.
-- NULL public_host = not cloud-reachable yet, skipped by the cron gatherer.
alter table devices add column if not exists public_host     text;
alter table devices add column if not exists public_port     integer;
-- Device's own total-record count at our last COMPLETE read — lets the cron
-- skip the expensive full attendance read when nothing changed (getInfo()'s
-- count is one cheap command vs. reading the whole buffer over the WAN).
alter table devices add column if not exists last_log_count  integer;

-- Employees: device PIN -> person's name, group, and work hours.
create table if not exists employees (
  pin       text primary key,
  name      text,
  "group"   text,     -- e.g. 'office' | 'worker' — free text, filters reports
  time_in   text,      -- "HH:MM" — falls back to settings.workStart when null
  time_out  text,      -- "HH:MM" — falls back to settings.workEnd when null
  off_days  integer[] not null default '{0,6}'   -- weekly recurring days off (0=Sun..6=Sat)
);
alter table employees add column if not exists off_days integer[] not null default '{0,6}';

-- Raw punches. ts = the device's LOCAL wall-clock (no timezone conversion).
create table if not exists punches (
  id         uuid primary key default gen_random_uuid(),
  device_id  uuid references devices(id) on delete set null,
  serial     text,
  pin        text not null,
  ts         timestamp not null,
  verify     integer default 0,
  status     integer default 0,
  source     text,
  created_at timestamptz not null default now()
);

-- Dedup: a PIN is global across devices (one person maps to one PIN no matter
-- which machine they punch on), so the same person at the same exact wall-clock
-- second is one real-world event regardless of device_id — key on (pin, ts),
-- NOT (device_id, pin, ts), so a live re-pull correctly skips punches that were
-- already captured under a different device_id (e.g. a historical import).
create unique index if not exists punches_dedup on punches (pin, ts);
create index if not exists punches_ts_idx  on punches (ts);
create index if not exists punches_pin_idx on punches (pin);

-- Punch count per device — a real GROUP BY aggregate computed in Postgres, so
-- the Devices page doesn't have to page through every punch row (64k+) client
-- side just to show a count next to each device.
create or replace view device_punch_counts as
  select device_id, count(*) as n from punches where device_id is not null group by device_id;

-- Per-PIN activity summary (one row per PIN) — powers the "suggest staff from
-- devices" review tool. Aggregating in Postgres keeps that endpoint to a single
-- small read instead of scanning every punch row client-side.
create or replace view pin_activity as
  select pin, count(*)::int as total, max(ts) as last_seen from punches group by pin;

-- Cache of each device's enrolled user (PIN -> name), refreshed periodically by
-- the puller. Lets the "suggest staff from devices" tool show names INSTANTLY
-- instead of dialing the devices live on every request (slow over WAN, and it
-- times out on Vercel's 60s function limit).
create table if not exists device_users (
  pin        text primary key,
  name       text,
  devices    text,
  updated_at timestamptz not null default now()
);

-- App login accounts (separate from `employees`, which is attendance-only data).
-- Password is bcrypt-hashed — never store plaintext once this lives in the cloud.
create table if not exists login_users (
  username      text primary key,
  password_hash text not null,
  role          text not null default 'user',     -- 'admin' | 'user'
  created_at    timestamptz not null default now()
);

-- Manual day-level overrides — the final source of truth for a (pin, date)
-- when set, beating whatever the raw punches or the weekly off-days pattern
-- would otherwise say. Covers: correcting a bad/missing scan ('present'),
-- an extra day off outside the weekly pattern ('day_off'), approved leave
-- ('leave'), or staff pre-notifying they can't scan / can't make it on time
-- ('excused'). `note` is REQUIRED — it's the actual record of what happened,
-- not decoration, and prints in the Daily/Summary report next to the status.
create table if not exists day_overrides (
  pin      text not null,
  date     date not null,
  status   text not null check (status in ('present', 'day_off', 'leave', 'excused')),
  note     text not null check (length(trim(note)) > 0),
  time_in  text,     -- "HH:MM" — manually-entered correction/record, e.g. for a bad/missing scan
  time_out text,     -- "HH:MM" — ignored for 'day_off'/'leave' (they shouldn't have worked hours)
  set_by   text,
  set_at   timestamptz not null default now(),
  primary key (pin, date)
);
alter table day_overrides add column if not exists time_in text;
alter table day_overrides add column if not exists time_out text;

-- Single-row report settings (work start/end, grace, timezone).
create table if not exists settings (
  id            integer primary key default 1,
  timezone      text not null default 'Asia/Phnom_Penh',
  work_start    text not null default '08:00',
  work_end      text not null default '18:00',
  grace_minutes integer not null default 5,
  check (id = 1)
);
insert into settings (id) values (1) on conflict (id) do nothing;

-- RLS: lock everything down. The cron puller and the Vercel API use the SERVICE key,
-- which bypasses RLS anyway. The anon/public key can read or write absolutely nothing.
alter table devices       enable row level security;
alter table employees     enable row level security;
alter table punches       enable row level security;
alter table login_users   enable row level security;
alter table settings      enable row level security;
alter table day_overrides enable row level security;
