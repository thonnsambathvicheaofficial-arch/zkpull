// TCP pull via node-zklib — READ-ONLY by design.
//
// This module only ever READS from a device: connect -> getInfo -> getAttendances
// -> disconnect. It NEVER calls clearAttendanceLog / disableDevice / powerOff or
// any destructive command. (The HRM once wiped four physical machines by
// automating a clear; that capability is deliberately absent here.)

const ZKLib = require('node-zklib')
const { fmtLocal } = require('./time')

// node-zklib rejects most calls with its own `ZKError` class, which does NOT
// extend Error and has no `.message` — the real text sits at err.err.message
// (ZKError also exposes `.toast()`, which additionally turns ECONNRESET /
// ECONNREFUSED into a friendlier sentence). Falling back to `String(err)` on
// a plain-object ZKError produces the useless literal string "[object Object]",
// so check every known shape before giving up.
function errMessage(err) {
  if (!err) return 'Unknown error'
  if (typeof err.toast === 'function') { try { const t = err.toast(); if (t) return t } catch { /* fall through */ } }
  if (err.err && err.err.message) return err.err.message
  if (err.message) return err.message
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}

// Pull the whole attendance buffer from one device. Never throws.
async function pullDevice(dev) {
  const ip = dev.ip
  const port = Number(dev.port) || 4370
  // Long read timeout: a big on-device buffer over a marginal WAN link can take
  // 20s+; too short a timeout truncates the read (oldest-first), silently
  // dropping the newest punches. 60s is generous for local/LAN pulls.
  const zk = new ZKLib(ip, port, 60000, 4000)
  const started = Date.now()
  try {
    await zk.createSocket()

    let info = {}
    try { info = (await zk.getInfo()) || {} } catch { /* getInfo can be picky — continue */ }

    const res = await zk.getAttendances()
    try { await zk.disconnect() } catch { /* ignore */ }

    const records = (res && res.data) || []
    const punches = records.map(r => {
      const d = new Date(r.recordTime)
      if (isNaN(d.getTime())) return null
      return { pin: String(r.deviceUserId), time: fmtLocal(d), verify: r.verifyType ?? 0, status: r.state ?? 0 }
    }).filter(Boolean)

    return { ok: true, total: records.length, logCounts: info.logCounts ?? null, punches, ms: Date.now() - started }
  } catch (err) {
    try { await zk.disconnect() } catch { /* ignore */ }
    return { ok: false, error: errMessage(err), ms: Date.now() - started }
  }
}

// Connectivity/info probe only — never reads the full log.
async function probeDevice(dev) {
  const zk = new ZKLib(dev.ip, Number(dev.port) || 4370, 8000, 4000)
  try {
    await zk.createSocket()
    let info = {}
    try { info = (await zk.getInfo()) || {} } catch { /* ignore */ }
    try { await zk.disconnect() } catch { /* ignore */ }
    return { ok: true, info }
  } catch (err) {
    try { await zk.disconnect() } catch { /* ignore */ }
    return { ok: false, error: errMessage(err) }
  }
}

module.exports = { pullDevice, probeDevice }
