# ZK Report Puller — Cloud (Vercel + Supabase + WAN Pull)

Remote attendance access over **WAN port forwarding**.

```
   Office LAN                          Cloud
 ┌───────────┐   port-forward   ┌──────────────┐   read   ┌────────────────────┐
 │ K40, B3-C │◄─────────────────│   Supabase   │◄─────────│ root app on Vercel │
 │ 192.168.x │    (via Router)  │  (Postgres)  │          │  reports / staff / │
 └───────────┘                  └─────────▲────┘          │  devices / users   │
                                          │               └──────────┬─────────┘
                                          │                          │ view from anywhere
                                          │   cron triggers          │
                                          └──────────────────────────┘
```

The system pulls each device directly over the internet by targeting the office router's public IP and a specific forwarded port for each device. Everything is **read-only** toward devices.

## 1 · Supabase
Schema lives in `cloud/supabase/schema.sql`.
A pg_cron extension job inside Supabase automatically hits the Vercel API endpoint `GET /api/cron/pull` every minute to trigger a background pull.

## 2 · Vercel (web reports — already deployed)
The **repo root** is deployed to Vercel. 
Env vars set on the Vercel project: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`, `CRON_SECRET`. Auto-deploys on every push to `main`.

## Security
- The **service_role key** lives only in Vercel's server-side env vars — never in a browser.
- RLS is enabled on every table with no public policies — the anon key (if it ever leaked) can read or write nothing.
- Devices are only ever **read** from; nothing is ever cleared, wiped, or commanded on them.
- Cron pulls are secured via `CRON_SECRET` bearer token matching.
