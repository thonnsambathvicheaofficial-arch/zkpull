// Tiny zero-dependency JSON store. No native modules (better-sqlite3 etc.) so it
// installs and runs anywhere with just Node — no build tools required.
//
// Everything is held in memory and persisted to ./data/*.json with an atomic
// write (tmp file + rename) so a crash mid-write can't corrupt the file.
// Dedup key for punches is pin|time (NOT deviceId|pin|time) — a PIN is already
// global across every device (one Staff record maps a PIN to one person
// regardless of which machine they punch on), so the same person's punch at the
// same exact wall-clock second is one real-world event no matter which device
// reports it. This matters in practice: historical logs can be imported once
// under a placeholder device, and later a live re-pull of the actual hardware
// (which may still hold years of on-device history) will correctly skip those
// same scans instead of double-counting them under a different device_id.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DIR = path.join(__dirname, '..', 'data')
fs.mkdirSync(DIR, { recursive: true })
const P = n => path.join(DIR, n)
const rd = (n, def) => { try { return JSON.parse(fs.readFileSync(P(n), 'utf8')) } catch { return def } }
const wr = (n, x) => { fs.writeFileSync(P(n) + '.tmp', JSON.stringify(x)); fs.renameSync(P(n) + '.tmp', P(n)) }

let devices   = rd('devices.json', [])
let punches   = rd('punches.json', [])
let employees = rd('employees.json', {})               // { pin: { name, group, timeIn, timeOut } }
// Migrate older shapes so existing files keep working, in order:
//   1. plain string "Name"              -> { name, group:null, timeIn:null, timeOut:null }
//   2. { name, shiftId }  (shift era)   -> shiftId resolved against legacy shifts.json and
//                                          copied into timeIn/timeOut, then dropped.
{
  let mig = false
  const legacyShifts = rd('shifts.json', [])
  const shiftById = Object.fromEntries(legacyShifts.map(s => [s.id, s]))
  for (const k of Object.keys(employees)) {
    let e = employees[k]
    if (typeof e === 'string') { e = { name: e }; mig = true }
    if (e.shiftId !== undefined) {
      const sh = e.shiftId ? shiftById[e.shiftId] : null
      e = { name: e.name, group: e.group ?? null, timeIn: e.timeIn ?? (sh ? sh.start : null), timeOut: e.timeOut ?? (sh ? sh.end : null) }
      mig = true
    }
    if (e.group === undefined) { e.group = null; mig = true }
    if (e.timeIn === undefined) { e.timeIn = null; mig = true }
    if (e.timeOut === undefined) { e.timeOut = null; mig = true }
    employees[k] = e
  }
  if (mig) wr('employees.json', employees)
}
let settings  = Object.assign(
  { timezone: 'Asia/Phnom_Penh', workStart: '08:00', workEnd: '18:00', graceMinutes: 5, autoPullMinutes: 0 },
  rd('settings.json', {}),
)
let meta      = rd('meta.json', {})                    // { deviceId: { at, inserted, total, ok, error } }

const keyset = new Set(punches.map(p => p.pin + '|' + p.time))

module.exports = {
  devices: {
    list: () => devices,
    get: id => devices.find(d => d.id === id),
    findBySerial: sn => devices.find(d => d.serial && d.serial.toLowerCase() === String(sn).toLowerCase()),
    add: d => {
      const row = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...d }
      devices.push(row); wr('devices.json', devices); return row
    },
    update: (id, patch) => { const d = devices.find(x => x.id === id); if (d) { Object.assign(d, patch); wr('devices.json', devices) } return d },
    remove: id => { devices = devices.filter(d => d.id !== id); wr('devices.json', devices) },
  },

  punches: {
    all: () => punches,
    count: () => punches.length,
    // arr: [{ pin, time, verify, status }]  -> returns number inserted (deduped)
    insertMany: (deviceId, serial, arr, source) => {
      let ins = 0
      for (const p of arr) {
        if (!p.pin || !p.time) continue
        const k = String(p.pin) + '|' + p.time
        if (keyset.has(k)) continue
        keyset.add(k)
        punches.push({ id: crypto.randomUUID(), deviceId, serial: serial || null, pin: String(p.pin), time: p.time, verify: p.verify || 0, status: p.status || 0, source })
        ins++
      }
      if (ins) wr('punches.json', punches)
      return ins
    },
    query: (f = {}) => punches.filter(p =>
      (!f.deviceId || p.deviceId === f.deviceId) &&
      (!f.from || p.time.slice(0, 10) >= f.from) &&
      (!f.to   || p.time.slice(0, 10) <= f.to) &&
      (!f.pin  || p.pin === String(f.pin))),
  },

  employees: {
    get: () => employees,                                          // { pin: { name, group, timeIn, timeOut } }
    names: () => Object.fromEntries(Object.entries(employees).map(([p, v]) => [p, (v && v.name) || ''])),
    // Explicit empty-string name is treated as "remove this PIN" (matches old behavior).
    // Any other call is a partial update — only the fields present in `data` change.
    set: (pin, data) => {
      const name = data && typeof data.name === 'string' ? data.name.trim() : undefined
      if (name === '') { delete employees[pin]; wr('employees.json', employees); return }
      const cur = employees[pin] || { name: '', group: null, timeIn: null, timeOut: null }
      employees[pin] = {
        name:    name !== undefined ? name : cur.name,
        group:   data && 'group'   in data ? (data.group || null)   : cur.group,
        timeIn:  data && 'timeIn'  in data ? (data.timeIn || null)  : cur.timeIn,
        timeOut: data && 'timeOut' in data ? (data.timeOut || null) : cur.timeOut,
      }
      wr('employees.json', employees)
    },
  },

  settings: {
    get: () => settings,
    set: patch => { Object.assign(settings, patch); wr('settings.json', settings); return settings },
  },

  meta: {
    get: () => meta,
    setPull: (id, r) => { meta[id] = r; wr('meta.json', meta) },
  },
}
