// ── ZK Pulling Logic (WAN) ──────────────────────────────────────────────────
// Pulling straight from Vercel/Cloud over WAN. Read-only toward devices:
// only ever calls getInfo()/getAttendances().
// Does NOT require a local agent.
//
// CRITICAL: node-zklib parses the device's naive wall-clock time using the
// SERVER's local timezone. Vercel's runtime defaults to UTC, which would shift
// every punch by the Cambodia offset. Pin it at module load so it's correct
// wherever this runs (Vercel, or a local test).
process.env.TZ = 'Asia/Phnom_Penh'

const sb = require('./supabase')

const pad = n => String(n).padStart(2, '0')
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

// Gather every device with a public endpoint set — the only ones the cloud can
// reach. A device with public_host = null is skipped (e.g. B3-C, until its
// port-forward is confirmed working again).
async function gatherTargets() {
  const { data, error } = await sb.from('devices').select('*').eq('type', 'pull').not('public_host', 'is', null)
  if (error) throw new Error(error.message)
  return data || []
}

// Pull one device end-to-end. Never throws — always resolves with a result row,
// and always writes the heartbeat (last_pull_at/ok/error/count) so the Devices
// page sync column reflects reality even on failure.
async function pullOne(ZKLib, dev, { full = false } = {}) {
  const started = Date.now()
  const host = dev.public_host
  const port = dev.public_port || 4370
  // The full attendance read runs over the WAN and can take tens of seconds for
  // a large buffer — generous but bounded so it stays under the function's
  // maxDuration (60s, see vercel.json).
  const readTimeout = 45000
  // 4000 is this device's comm-key/password (matches cloud/agent.js's LAN
  // pull) — without it CMD_CONNECT gets silently dropped (no reply), which
  // looks exactly like a network timeout rather than an auth rejection.
  const makeZk = () => new ZKLib(host, port, readTimeout, 4000)
  let zk = makeZk()

  const heartbeat = (patch) => sb.from('devices').update({ last_pull_at: new Date().toISOString(), ...patch }).eq('id', dev.id)

  try {
    // Connect with one retry — a lone dropped SYN over a WAN link is common and
    // not worth failing the whole poll for.
    try {
      await zk.createSocket()
    } catch (connErr) {
      const code = (connErr && (connErr.err || connErr))?.code
      const transient = ['ETIMEDOUT', 'ETIMEOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)
      if (!transient) throw connErr
      try { await zk.disconnect() } catch { /* ignore dead socket */ }
      await new Promise(r => setTimeout(r, 500))
      zk = makeZk()
      await zk.createSocket()
    }

    let info = {}
    try { info = (await zk.getInfo()) || {} } catch { /* getInfo can be picky */ }

    // Change-detection gate: getInfo()'s logCounts is one cheap command that
    // returns the device's TOTAL stored record count. If it hasn't grown since
    // our last COMPLETE read, there's nothing new — skip the expensive full
    // getAttendances() read entirely (thousands of records over a WAN link).
    const logCount = typeof info.logCounts === 'number' ? info.logCounts : null
    const logCapacity = typeof info.logCapacity === 'number' ? info.logCapacity : null
    const nearCapacity = logCount != null && logCapacity != null && logCapacity > 0 && logCount >= logCapacity * 0.95
    const mustFullRead = full || logCount == null || dev.last_log_count == null || logCount !== dev.last_log_count || nearCapacity

    if (!mustFullRead) {
      await zk.disconnect()
      await heartbeat({ last_pull_ok: true, last_pull_error: null, last_pull_count: 0 })
      return { device: dev.name, ok: true, skippedRead: true, totalOnDevice: logCount, pushed: 0, ms: Date.now() - started }
    }

    const { data: allRecords, err: readErr } = await zk.getAttendances()
    try { await zk.disconnect() } catch { /* ignore */ }

    const recs = allRecords || []
    const rows = recs.map(r => {
      const d = new Date(r.recordTime)
      if (isNaN(d.getTime())) return null
      return { device_id: dev.id, serial: dev.serial || null, pin: String(r.deviceUserId), ts: fmt(d), verify: r.verifyType ?? 0, status: r.state ?? 0, source: 'cron' }
    }).filter(Boolean)

    let pushed = 0
    if (rows.length) {
      const { error: upErr, count } = await sb.from('punches')
        .upsert(rows, { onConflict: 'pin,ts', ignoreDuplicates: true, count: 'exact' })
      if (upErr) {
        await heartbeat({ last_pull_ok: false, last_pull_error: upErr.message, last_pull_count: null })
        return { device: dev.name, ok: false, error: upErr.message, ms: Date.now() - started }
      }
      pushed = count ?? 0
    }

    // Advance the change-detection baseline ONLY on a provably complete read
    // (readCount >= the device's own reported total) — a truncated WAN read
    // must not be mistaken for "caught up", or the gate would skip re-reading
    // the unread tail forever.
    const complete = !readErr && logCount != null && recs.length >= logCount
    if (complete) await sb.from('devices').update({ last_log_count: logCount }).eq('id', dev.id)

    await heartbeat({ last_pull_ok: true, last_pull_error: null, last_pull_count: pushed })
    return { device: dev.name, ok: true, totalOnDevice: recs.length, pushed, truncated: !!readErr, ms: Date.now() - started }

  } catch (err) {
    try { await zk.disconnect() } catch { /* ignore */ }
    const inner = (err && err.err) || err
    const msg = [inner?.code, inner?.message].filter(Boolean).join(' ') || String(err)
    await heartbeat({ last_pull_ok: false, last_pull_error: msg, last_pull_count: null })
    return { device: dev.name, ok: false, error: msg, ms: Date.now() - started }
  }
}

async function pullAll({ full = false } = {}) {
  const targets = await gatherTargets()
  if (!targets.length) return { ok: true, devices: 0, results: [], note: 'No devices with a public_host set yet.' }
  const ZKLib = require('node-zklib')
  const results = await Promise.all(targets.map(dev => pullOne(ZKLib, dev, { full })))
  return { ok: results.every(r => r.ok), devices: results.length, results }
}

module.exports = { pullAll, pullOne }
