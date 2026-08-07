# ZK Report Puller — Cloud (Vercel + Supabase)

Remote attendance access **without exposing the device to the internet**.

```
   Office LAN                         Cloud
 ┌───────────┐   local pull   ┌──────────────┐   read    ┌──────────────┐
 │   K40     │◄───────────────│  agent (PC)  │──push────►│   Supabase   │◄──────│  Vercel web  │
 │ .0.201    │                │  on-site     │           │  (Postgres)  │        │  reports/UI  │
 └───────────┘                └──────────────┘           └──────────────┘        └──────┬───────┘
                                                                                          │ view from anywhere
```

The **agent** runs on an always-on PC inside the office. It pulls each device over
the LAN (fast, reliable) and pushes punches to **Supabase**. **Vercel** hosts the
report UI, reading from Supabase — so you view attendance from any network. The K40
is never port-forwarded or exposed. Everything is **read-only** toward devices.

## Prerequisites
- A **Supabase** account (free tier is fine) — hosted Postgres.
- A **Vercel** account (free/Hobby is fine) — hosts the web app.
- One **always-on PC** at the office to run the agent (any Windows/Mac/Linux box on the LAN).

## 1 · Supabase (database)
1. Create a new project. Note the **Project URL** and the **service_role key**
   (Project Settings → API). The service key is secret.
2. Open the **SQL Editor** and run, in order:
   - `supabase/schema.sql`  — creates the tables
   - `supabase/seed.sql`    — inserts the **K40** device and your **119 employees**

## 2 · Vercel (web reports)
1. Deploy the `cloud/web/` folder to Vercel (import the repo, or `vercel` CLI from that folder).
2. Set Environment Variables (Project → Settings → Environment Variables):
   - `SUPABASE_URL` = your project URL
   - `SUPABASE_SERVICE_KEY` = the service_role key
   - `WORK_START` = `08:00`  ·  `GRACE_MIN` = `5`
3. Open the deployed URL — Reports / Employees / Devices. (No data until the agent runs.)

## 3 · Agent (on-site puller)
On the office PC:
```bash
cd cloud/agent
copy .env.example .env      # then edit .env with your Supabase URL + service key
npm install
npm start
```
It pulls every device in Supabase (`type = pull`) every `PULL_INTERVAL_MIN` minutes
and pushes new punches. Leave it running (or install it as a service / `pm2 start agent.js`).
The K40 is already seeded, so it starts collecting immediately once it's on the `192.168.0.x` LAN.

## The PIN caveat
The employee list uses IDs like `SF0003`. ZK devices usually report **numeric** PINs.
After the first real pull, check the **Raw punches** view: if PINs come back as numbers
(`3`, `107`…) they won't match `SF####`. If so, tell me the format and I'll add a one-line
crosswalk (`SF0003 → 3`) — the numeric parts already line up.

## Security
- The **service_role key** lives only on the agent PC and in Vercel's server env — never in a browser.
- RLS is enabled with no public policies, so the anon key can read nothing.
- The device is only ever **read**; it is never exposed to the internet.
