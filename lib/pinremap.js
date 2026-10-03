// Device-scoped PIN remap.
//
// A reader that mis-matches a fingerprint logs one person's scans under two user
// IDs. For each remap {deviceId, from, to} the punches of `from` that came from
// `deviceId` are re-attributed to `to` — EXCEPT on a day where `to` already has a
// full day of its own (>= FULL_DAY_MIN between its first and last punch, from any
// device). There the `from` punch is far more likely the real owner of `from`
// (e.g. 107 genuinely scanning B3-C), so it stays put. Raw rows are never changed;
// a remapped punch carries remappedFrom so it stays traceable.
const FULL_DAY_MIN = 240

// B3-C (705f0b5d) logs worker 438 Chhiv Thet's scans under user ID 107 about half
// the time (one fingerprint matches both IDs); 107 is office staff on K40 and has
// no business on B3-C. Pattern visible since 2026-08-03: each day the 107 + 438
// B3-C punches together form ONE in/out. Remove an entry here to undo it.
const PIN_REMAPS = [
  { deviceId: '705f0b5d-a00c-4137-bfa7-bae3ef024e49', from: '107', to: '438' },
]

const minutesOf = (time) => {
  const [h, m] = time.slice(11, 16).split(':').map(Number)
  return h * 60 + m
}

function applyPinRemaps(punches, remaps = PIN_REMAPS) {
  if (!remaps || !remaps.length) return punches
  const byKey = new Map(remaps.map(r => [`${r.deviceId}|${r.from}`, r.to]))
  // to-pin -> date -> [minutes of its OWN (non-remapped) punches]
  const targets = new Set(remaps.map(r => r.to))
  const own = new Map()
  for (const p of punches) {
    if (!targets.has(p.pin)) continue
    const day = p.time.slice(0, 10)
    const k = `${p.pin}|${day}`
    if (!own.has(k)) own.set(k, [])
    own.get(k).push(minutesOf(p.time))
  }
  const hasFullDay = (pin, day) => {
    const m = own.get(`${pin}|${day}`)
    return !!m && m.length >= 2 && Math.max(...m) - Math.min(...m) >= FULL_DAY_MIN
  }
  return punches.map(p => {
    const to = byKey.get(`${p.deviceId}|${p.pin}`)
    if (!to || hasFullDay(to, p.time.slice(0, 10))) return p
    return { ...p, pin: to, remappedFrom: p.pin }
  })
}

module.exports = { applyPinRemaps }
