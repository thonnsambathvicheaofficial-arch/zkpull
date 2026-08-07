# ZK Report Puller — Cloud (Vercel + Supabase + on-site agent)

Remote attendance access **without exposing any device to the internet**.

```
   Office LAN                          Cloud
 ┌───────────┐   local pull   ┌──────────────┐   push    ┌──────────────┐   read   ┌────────────────────┐
 │ K40, B3-C │◄───────────────│ cloud/agent  │──────────►│   Supabase   │◄─────────│ root app on Vercel │
 │ 192.168.x │                │  (on-site)   │           │  (Postgres)  │          │  reports / staff / │
 └───────────┘                └──────────────┘           └──────────────┘          │  devices / users   │
                                                                                     └──────────┬─────────┘
                                                                                                 │ view from anywhere
```

**`cloud/agent`** is the *only* thing that ever talks to a device. It runs on an
always-on PC inside the office, pulls each device over the LAN, and pushes
punches to Supabase. Everything else — the reports web app at the repo root
(`server.js` + `lib/` + `public/`) — is deployed on Vercel and only ever reads
and writes Supabase; it has no way to reach a device's private LAN address at
all (that's the whole reason the agent exists). Everything is **read-only**
toward devices.

## 1 · Supabase (already set up)
Schema lives in `cloud/supabase/schema.sql`. Ignore `seed.sql` — it's stale
placeholder data from before the real staff list was migrated in; don't run it.

## 2 · Vercel (web reports — already deployed)
The **repo root** (not `cloud/web`, which no longer exists) is what's deployed
to Vercel. Env vars set on the Vercel project: `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `SESSION_SECRET`. Auto-deploys on every push to `main`.

## 3 · Agent (on-site puller — needs to be running somewhere)

On a PC that's on the same network as the devices:

```bash
cd cloud/agent
copy .env.example .env      REM then edit .env: SUPABASE_URL + SUPABASE_SERVICE_KEY
npm install
npm start                   REM runs in the foreground — fine for a quick test
```

**To make it survive reboots** (Windows), instead of `npm start`, run
**`install-agent.bat`** (double-click it — it prompts for admin access via UAC,
needed to register a boot-time task). This registers a Scheduled Task that:
- starts automatically at boot, even before anyone logs in (`SYSTEM` account)
- restarts itself if it crashes
- logs to `cloud/agent/agent.log` (grows over time — no rotation yet, clear it
  occasionally if it gets large)

Requires `.env` to already exist and be filled in — the installer refuses to
run without it (never auto-generates one, since it holds a secret key).

To remove it later: `uninstall-agent.bat` (same admin-prompt pattern).

To check on it manually: `Get-ScheduledTask "ZK Attendance Agent" | Get-ScheduledTaskInfo`

## Security
- The **service_role key** lives only in `cloud/agent/.env` (on the agent PC,
  gitignored) and in Vercel's server-side env vars — never in a browser.
- RLS is enabled on every table with no public policies — the anon key (if it
  ever leaked) can read or write nothing.
- Devices are only ever **read** from; nothing is ever cleared, wiped, or
  commanded on them, and none are exposed to the internet.
