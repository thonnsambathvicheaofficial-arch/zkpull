// Attendance slotting — identical to the local app's tested logic.
// Punches resolved by SCAN ORDER: first=In, last=Out, 2nd & 2nd-to-last = lunch
// (only when there are >=4 punches). Times may be "YYYY-MM-DD HH:MM:SS" or ISO
// "YYYY-MM-DDTHH:MM:SS" — both share the same index positions, so slicing works.

function diffMinutes(a, b) {
  return (new Date(b.replace(' ', 'T')) - new Date(a.replace(' ', 'T'))) / 60000
}
const hm = s => (s ? s.slice(11, 16) : '')
const hhmmToMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m }

function resolveDay(dayPunches, settings) {
  const t = dayPunches.map(p => p.time).sort()
  const n = t.length
  const inF = t[0]
  const outF = n > 1 ? t[n - 1] : null
  let loF = null, liF = null
  if (n >= 4) { loF = t[1]; liF = t[n - 2] }
  else if (n === 3) { loF = t[1] }

  let mins = 0
  if (outF) { mins = diffMinutes(inF, outF); if (loF && liF) mins -= Math.max(0, diffMinutes(loF, liF)) }
  const hours = Math.max(0, Math.round(mins / 6) / 10)

  let late = false
  if (settings.workStart) {
    const inMin = hhmmToMin(inF.slice(11, 16))
    late = inMin > hhmmToMin(settings.workStart) + (Number(settings.graceMinutes) || 0)
  }
  return { in: hm(inF), lunchOut: hm(loF), lunchIn: hm(liF), out: hm(outF), hours, punches: n, late }
}

function dailyRows(punches, employees, settings) {
  const groups = new Map()
  for (const p of punches) {
    const date = p.time.slice(0, 10)
    const k = p.pin + '|' + date
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(p)
  }
  const rows = []
  for (const [k, ps] of groups) {
    const [pin, date] = k.split('|')
    rows.push({ pin, name: employees[pin] || '', date, ...resolveDay(ps, settings) })
  }
  rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.name || a.pin).localeCompare(b.name || b.pin))
  return rows
}

function summaryRows(daily) {
  const m = new Map()
  for (const r of daily) {
    if (!m.has(r.pin)) m.set(r.pin, { pin: r.pin, name: r.name, days: 0, hours: 0, late: 0 })
    const o = m.get(r.pin); o.days++; o.hours += r.hours; if (r.late) o.late++
  }
  return [...m.values()].map(o => ({ ...o, hours: Math.round(o.hours * 10) / 10 }))
    .sort((a, b) => (a.name || a.pin).localeCompare(b.name || b.pin))
}

module.exports = { dailyRows, summaryRows, resolveDay }
