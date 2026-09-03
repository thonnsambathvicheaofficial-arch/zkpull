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

// Must be required BEFORE any ZKLib instance is created — it overrides
// node-zklib's multi-chunk read, which hangs forever on a large device over a
// WAN link. See lib/zk-readfix.js for the full explanation (this replaced a
// patch-package patch that kept breaking on Vercel's build cache).
require('./zk-readfix')

const sb = require('./supabase')

const pad = n => String(n).padStart(2, '0')
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

// node-zklib's getAttendances() has its OWN internal chunk-receive timer
// hardcoded to 180s (readWithBuffer in the library, unrelated to whatever
// readTimeout we pass the constructor) — far past Vercel's 60s function
// ceiling (vercel.json maxDuration). If a read ever stalls, the platform
// SIGKILLs the whole function before that internal timer — or anything of
// ours — can fire: no catch block runs, no heartbeat gets written, and the
// Devices page keeps showing the LAST successful heartbeat as healthy
// indefinitely. This is how B3-C's backlog went unnoticed for weeks — not a
// reported failure, a total silent kill. We race every read against our own
// timeout, safely under the platform ceiling, so a stall fails INSIDE our
// try/catch (retried, and if still failing, recorded in last_pull_error)
// instead of vanishing without a trace.
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Timestamp sanity bounds. ZKTeco devices can produce wildly wrong dates when
// their RTC battery dies or the device restarts after a power cut — the Aug 21
// incident produced timestamps in year 2119. Records outside this window are
// quarantined (logged to corrupted_punches, never inserted into punches) so
// they cannot silently distort attendance reports.
const TS_MIN = new Date('2020-01-01T00:00:00Z')
const tsMax = () => { const d = new Date(); d.setFullYear(d.getFullYear() + 2); return d }

// B3-C injects a phantom record for a recurring group of PINs in the first
// couple minutes after local midnight — confirmed on 21 of 36 sampled nights
// (2026-08-25 audit): the SAME ~7 PINs, a few seconds apart, in a consistent
// order, night after night. That signature (multiple different PINs, seconds
// apart, same tiny window, recurring on a schedule) is a device housekeeping /
// buffer-flush routine, not real scans — nobody clocks in at 00:00:0X on cue.
// Keyed by device ID (not name) so renaming a device in the Devices UI can't
// silently disable this. Add another device's ID here only after confirming
// the same recurring-PIN-at-midnight signature — don't apply it blindly, a
// real overnight shift starting near midnight is legitimate on other devices.
const MIDNIGHT_ARTIFACT_DEVICE_IDS = new Set([
  '705f0b5d-a00c-4137-bfa7-bae3ef024e49', // B3-C
])
const MIDNIGHT_ARTIFACT_END_MIN = 2   // minutes after local midnight; observed instances top out ~1:05

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

    if (logCount === 0) {
      await zk.disconnect()
      await heartbeat({ last_pull_ok: true, last_pull_error: null, last_pull_count: 0, last_log_count: 0 })
      return { device: dev.name, ok: true, totalOnDevice: 0, pushed: 0, ms: Date.now() - started }
    }

    // Bounded, retrying read (see withTimeout above for why this exists).
    // Attempt 1 gets the bulk of the budget (a full 3,400-record buffer read
    // in ~3s under healthy conditions, so 30s is already generous — past that
    // it's very likely stalled, not just slow). Attempt 2, on a fresh
    // connection, gets what's left. Either way we stay well under Vercel's
    // 60s ceiling, so a stall gets caught and reported instead of killed.
    const READ_TIMEOUT_MS = [30000, 20000]
    let allRecords = null, readErr = null
    for (let attempt = 0; attempt < READ_TIMEOUT_MS.length; attempt++) {
      try {
        const res = await withTimeout(zk.getAttendances(), READ_TIMEOUT_MS[attempt], 'getAttendances')
        allRecords = res.data
        readErr = res.err || null
      } catch (e) {
        readErr = e
      }
      const gotEnough = logCount == null || (allRecords || []).length >= logCount
      if (!readErr && gotEnough) break
      if (attempt < READ_TIMEOUT_MS.length - 1) {
        try { await zk.disconnect() } catch { /* ignore dead socket */ }
        await new Promise(r => setTimeout(r, 500))
        zk = makeZk()
        try { await zk.createSocket() } catch (reconnErr) { readErr = reconnErr; break }
      }
    }
    try { await zk.disconnect() } catch { /* ignore */ }

    const recs = allRecords || []
    const maxDate = tsMax()
    const rows = []
    const badRows = []
    for (const r of recs) {
      const d = new Date(r.recordTime)
      if (isNaN(d.getTime())) continue
      const row = { device_id: dev.id, serial: dev.serial || null, pin: String(r.deviceUserId), ts: fmt(d), verify: r.verifyType ?? 0, status: r.state ?? 0, source: 'cron' }
      const isOutOfRange = d < TS_MIN || d > maxDate
      const isMidnightArtifact = !isOutOfRange
        && MIDNIGHT_ARTIFACT_DEVICE_IDS.has(dev.id)
        && d.getHours() === 0 && d.getMinutes() < MIDNIGHT_ARTIFACT_END_MIN
      if (isOutOfRange || isMidnightArtifact) {
        // Quarantine it — never insert into punches.
        const reason = isOutOfRange ? 'out_of_range_timestamp' : 'midnight_artifact'
        console.warn(`[${dev.name}] ${isOutOfRange ? 'Corrupted' : 'Phantom midnight'} timestamp for PIN ${row.pin}: ${row.ts} — quarantining`)
        badRows.push({ ...row, device_name: dev.name, detected_at: new Date().toISOString(), reason })
      } else {
        rows.push(row)
      }
    }

    // Persist quarantined records best-effort (non-fatal — missing this table
    // just means the warning stays in logs only).
    if (badRows.length) {
      try {
        await sb.from('corrupted_punches')
          .upsert(badRows, { onConflict: 'pin,ts', ignoreDuplicates: true })
      } catch { /* table may not exist yet — warning already logged above */ }
    }

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

    // A read that's STILL incomplete after both attempts must show up as a
    // failed sync, not a healthy one — this exact "reported ok, actually
    // truncated" gap is what let B3-C's backlog sit invisible for weeks.
    // Whatever punches we DID capture are still pushed (below), so this
    // isn't a hard failure — but the Devices page needs to see it.
    const readErrMsg = readErr ? (readErr.message || String(readErr)) : null
    await heartbeat({ last_pull_ok: !readErr, last_pull_error: readErr ? `Incomplete read: ${readErrMsg}` : null, last_pull_count: pushed })
    return { device: dev.name, ok: true, totalOnDevice: recs.length, pushed, corrupted: badRows.length, truncated: !!readErr, ms: Date.now() - started }

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

// Read the enrolled user table (PIN -> name) from every reachable pull device.
// Best-effort: a device that's offline or busy is skipped, never fatal.
// Read-only — getUsers() only reads the device's user list, never modifies it.
async function deviceUsers() {
  const targets = await gatherTargets()
  const ZKLib = require('node-zklib')
  const byPin = new Map() // pin -> { name, devices:Set }
  for (const dev of targets) {
    const zk = new ZKLib(dev.public_host, dev.public_port || 4370, 20000, 4000)
    try {
      await zk.createSocket()
      const res = await zk.getUsers()
      try { await zk.disconnect() } catch { /* ignore */ }
      for (const u of (res && res.data) || []) {
        const pin = String(u.userId ?? u.uid)
        const name = (u.name || '').trim()
        if (!byPin.has(pin)) byPin.set(pin, { name: '', devices: new Set() })
        const e = byPin.get(pin)
        if (name && !e.name) e.name = name
        e.devices.add(dev.name)
      }
    } catch { try { await zk.disconnect() } catch { /* ignore */ } }
  }
  const out = {}
  for (const [pin, e] of byPin) out[pin] = { name: e.name, devices: [...e.devices] }
  return out
}

// Dial the devices for their enrolled user list and upsert it into the
// device_users cache (additive — only pins successfully read are updated, so a
// device that's momentarily unreachable never wipes previously-cached names).
async function refreshDeviceUsers() {
  const users = await deviceUsers()
  const rows = Object.entries(users).map(([pin, u]) => ({
    pin, name: u.name || null, devices: (u.devices || []).join('+'), updated_at: new Date().toISOString(),
  }))
  if (!rows.length) return 0
  const { error } = await sb.from('device_users').upsert(rows, { onConflict: 'pin' })
  if (error) throw new Error(error.message)
  return rows.length
}

async function wipeOne(ZKLib, dev) {
  const host = dev.public_host
  const port = dev.public_port || 4370
  const zk = new ZKLib(host, port, 10000, 4000)
  try {
    await zk.createSocket()
    await zk.clearAttendanceLog()
    try { await zk.disconnect() } catch {}
    
    // reset last_log_count to 0
    await sb.from('devices').update({ last_log_count: 0 }).eq('id', dev.id)
    return { ok: true }
  } catch (err) {
    try { await zk.disconnect() } catch {}
    const inner = (err && err.err) || err
    const msg = [inner?.code, inner?.message].filter(Boolean).join(' ') || String(err)
    return { ok: false, error: msg }
  }
}

module.exports = { pullAll, pullOne, wipeOne, deviceUsers, refreshDeviceUsers }
