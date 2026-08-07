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

-- Employees: device PIN -> person's name.
create table if not exists employees (
  pin  text primary key,
  name text
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

-- Dedup: the same (device, person, exact time) is stored once — re-pulling is safe.
create unique index if not exists punches_dedup on punches (device_id, pin, ts);
create index if not exists punches_ts_idx  on punches (ts);
create index if not exists punches_pin_idx on punches (pin);

-- RLS: lock everything down. The agent and the Vercel API use the SERVICE key,
-- which bypasses RLS. No anon/browser access — never ship the service key to a client.
alter table devices   enable row level security;
alter table employees enable row level security;
alter table punches   enable row level security;
