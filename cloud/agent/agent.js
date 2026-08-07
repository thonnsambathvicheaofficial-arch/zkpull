// ZK → Supabase agent  (runs on an always-on PC INSIDE the office network)
//
// This is what makes remote access possible. The K40 is a passive device on a
// private LAN — the cloud can't reach it. So instead, this agent sits inside the
// network, pulls each device LOCALLY over the LAN (fast, reliable, no truncation),
// and PUSHES the punches up to Supabase. Vercel then reads from Supabase, so you
// can view reports from anywhere. The device is never exposed to the internet.
//
// READ-ONLY: it only reads from devices — never clears, wipes, or commands them.

// Load .env from this file's own folder, not the caller's working directory —
// Windows Task Scheduler / Startup shortcuts don't reliably set the working
// directory, so a plain require('dotenv').config() can silently miss it.
require('dotenv').config({ path: require('path').join(__dirname, '.env') })
const { createClient } = require('@supabase/supabase-js')
const ZKLib = require('node-zklib')

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env
const INTERVAL_MIN = Number(process.env.PULL_INTERVAL_MIN) || 15
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing config. Copy .env.example to .env and set SUPABASE_URL and SUPABASE_SERVICE_KEY.')
  process.exit(1)
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

const pad = n => String(n).padStart(2, '0')
// Device Date -> "YYYY-MM-DD HH:MM:SS" in local wall-clock (node-zklib builds the
// Date from the device's own clock components, so local getters reproduce it 1:1).
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

async function pullDevice(dev) {
  const zk = new ZKLib(dev.ip, dev.port || 4370, 60000, 4000)
  try {
    await zk.createSocket()
    try { await zk.getInfo() } catch { /* optional */ }
    const res = await zk.getAttendances()
    try { await zk.disconnect() } catch { /* ignore */ }
    const recs = (res && res.data) || []
    const rows = recs.map(r => {
      const d = new Date(r.recordTime)
      if (isNaN(d.getTime())) return null
      return { device_id: dev.id, serial: dev.serial || null, pin: String(r.deviceUserId), ts: fmt(d), verify: r.verifyType ?? 0, status: r.state ?? 0, source: 'agent' }
    }).filter(Boolean)
    return { ok: true, total: recs.length, rows }
  } catch (err) {
    try { await zk.disconnect() } catch { /* ignore */ }
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

async function cycle() {
  const { data: devices, error } = await sb.from('devices').select('*').eq('type', 'pull')
  if (error) { console.error(`[${now()}] could not fetch devices: ${error.message}`); return }
  const pull = (devices || []).filter(d => d.ip)
  if (!pull.length) { console.log(`[${now()}] no TCP-pull devices configured in Supabase yet`); return }

  for (const dev of pull) {
    const r = await pullDevice(dev)
    if (!r.ok) { console.log(`[${now()}] ${dev.name}: pull FAILED — ${r.error}`); continue }
    let pushed = 0
    if (r.rows.length) {
      // Upsert with ignoreDuplicates → INSERT ... ON CONFLICT DO NOTHING against
      // the punches_dedup unique index (pin, ts) — a PIN is global across
      // devices, so this also correctly skips punches already captured under a
      // different device_id (e.g. a historical import). Re-pulling is always safe.
      const { error: upErr, count } = await sb.from('punches')
        .upsert(r.rows, { onConflict: 'pin,ts', ignoreDuplicates: true, count: 'exact' })
      if (upErr) { console.log(`[${now()}] ${dev.name}: push error — ${upErr.message}`); continue }
      pushed = count ?? 0
    }
    console.log(`[${now()}] ${dev.name}: read ${r.total} on device, pushed ${pushed} new`)
  }
}

console.log(`ZK → Supabase agent started. Pulling every ${INTERVAL_MIN} min. (Ctrl+C to stop.)`)
cycle()
setInterval(cycle, INTERVAL_MIN * 60 * 1000)
