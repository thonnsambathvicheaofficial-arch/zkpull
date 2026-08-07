-- ZK Report Puller — Supabase schema.  Run once in the Supabase SQL editor.

create extension if not exists pgcrypto;

-- Devices. The on-site agent reads this list and pulls each 'pull' device.
create table if not exists devices (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  type       text not null default 'pull',      -- 'pull' | 'adms'
  ip         text,
  port       integer not null default 4370,
  serial     text,
  created_at timestamptz not null default now()
);

-- Employees: device PIN -> person's name, group, and work hours.
create table if not exists employees (
  pin       text primary key,
  name      text,
  "group"   text,     -- e.g. 'office' | 'worker' — free text, filters reports
  time_in   text,      -- "HH:MM" — falls back to settings.workStart when null
  time_out  text       -- "HH:MM" — falls back to settings.workEnd when null
);

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

-- App login accounts (separate from `employees`, which is attendance-only data).
-- Password is bcrypt-hashed — never store plaintext once this lives in the cloud.
create table if not exists login_users (
  username      text primary key,
  password_hash text not null,
  role          text not null default 'user',     -- 'admin' | 'user'
  created_at    timestamptz not null default now()
);

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

-- RLS: lock everything down. The agent and the Vercel API use the SERVICE key,
-- which bypasses RLS. No anon/browser access — never ship the service key to a client.
alter table devices     enable row level security;
alter table employees   enable row level security;
alter table punches     enable row level security;
alter table login_users enable row level security;
alter table settings    enable row level security;
