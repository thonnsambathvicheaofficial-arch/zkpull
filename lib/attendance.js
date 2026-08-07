// Turn raw punches into daily attendance — the core reporting logic.
//
// PUNCH SLOTTING (hard-won HRM rule): a day's punches are resolved by SCAN ORDER,
// never by absolute time-of-day windows. Staff punch IN and OUT only (no lunch
// break tracked), so: first scan of the day -> IN, last scan -> OUT. Any scans
// in between (retries, stray double-taps) are ignored for the calculation but
// still counted in Punches. Worked hours = OUT - IN, full span, no deduction.

const { hm, diffMinutes, hhmmToMin } = require('./time')

// The effective punch rule for a staff member: their own Time In / Time Out
// (set on the Staff page), or the global defaults (Settings) when unset.
// Grace is always the global grace-minutes setting, applied both directions.
function ruleFor(pin, employees, settings) {
  const e = employees[pin]
  const start = (e && e.timeIn) || settings.workStart
  const end = (e && e.timeOut) || settings.workEnd
  return { start, end, grace: Number(settings.graceMinutes) || 0 }
}

function resolveDay(dayPunches, rule) {
  const t = dayPunches.map(p => p.time).sort()   // full "YYYY-MM-DD HH:MM:SS", ascending
  const n = t.length
  const inF = t[0]
  const outF = n > 1 ? t[n - 1] : null

  const mins = outF ? diffMinutes(inF, outF) : 0
  const hours = Math.max(0, Math.round(mins / 6) / 10)   // 1-decimal hours

  // Late = first IN later than the staff's Time In (or the default) + grace.
  let late = false
  if (rule.start) {
    const inMin = hhmmToMin(inF.slice(11, 16))
    late = inMin > hhmmToMin(rule.start) + (Number(rule.grace) || 0)
  }

  // Early leave = last OUT earlier than the staff's Time Out (or the default)
  // minus grace. Only judged when there IS an out punch — a single-punch day
  // (no out at all) is a missing-scan problem, not "left early".
  let earlyLeave = false
  if (rule.end && outF) {
    const outMin = hhmmToMin(outF.slice(11, 16))
    earlyLeave = outMin < hhmmToMin(rule.end) - (Number(rule.grace) || 0)
  }

  return { in: hm(inF), out: hm(outF), hours, punches: n, late, earlyLeave }
}

// One row per (pin, date), for staff who exist in the Staff list ONLY — a PIN
// that punches but was never added to Staff produces no row here. (The Raw
// Punches view stays unfiltered — that's the diagnostic device-log view for
// spotting a PIN worth adding.) `group` is the staff's assigned group
// (office/worker/null) — carried through regardless of which device the punch
// came from, so callers can filter or label by group.
function dailyRows(punches, employees, settings) {
  const groups = new Map()
  for (const p of punches) {
    if (!employees[p.pin]) continue
    const date = p.time.slice(0, 10)
    const k = p.pin + '|' + date
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(p)
  }
  const rows = []
  for (const [k, ps] of groups) {
    const [pin, date] = k.split('|')
    const e = employees[pin]
    const day = resolveDay(ps, ruleFor(pin, employees, settings))
    rows.push({ pin, name: e.name || '', group: e.group || null, date, ...day })
  }
  rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.name || a.pin).localeCompare(b.name || b.pin))
  return rows
}

// One row per employee across the range.
function summaryRows(daily) {
  const m = new Map()
  for (const r of daily) {
    if (!m.has(r.pin)) m.set(r.pin, { pin: r.pin, name: r.name, group: r.group, days: 0, hours: 0, late: 0, early: 0 })
    const o = m.get(r.pin)
    o.days++; o.hours += r.hours; if (r.late) o.late++; if (r.earlyLeave) o.early++
  }
  return [...m.values()]
    .map(o => ({ ...o, hours: Math.round(o.hours * 10) / 10 }))
    .sort((a, b) => (a.name || a.pin).localeCompare(b.name || b.pin))
}

// Enumerate the days of a "YYYY-MM" month with weekday + weekend flags.
function monthDays(month) {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  const wdName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const out = []
  for (let d = 1; d <= last; d++) {
    const dt = new Date(y, m - 1, d)
    out.push({ d, wd: wdName[dt.getDay()], weekend: dt.getDay() === 0 || dt.getDay() === 6 })
  }
  return out
}

// Monthly timesheet: pivot daily attendance into employee-rows × day-columns.
function timesheet(punches, employees, settings, month) {
  const days = monthDays(month)
  const daily = dailyRows(punches, employees, settings)
  const byPin = new Map()
  for (const r of daily) {
    if (!byPin.has(r.pin)) byPin.set(r.pin, { pin: r.pin, name: r.name || (employees[r.pin] && employees[r.pin].name) || '', group: r.group, cells: {}, totalHours: 0, daysPresent: 0, lateDays: 0, earlyDays: 0 })
    const o = byPin.get(r.pin)
    o.cells[Number(r.date.slice(8, 10))] = { hours: r.hours, late: r.late, earlyLeave: r.earlyLeave, in: r.in, out: r.out }
    o.totalHours += r.hours; o.daysPresent += 1; if (r.late) o.lateDays += 1; if (r.earlyLeave) o.earlyDays += 1
  }
  const rows = [...byPin.values()]
    .map(o => ({ ...o, totalHours: Math.round(o.totalHours * 10) / 10 }))
    .sort((a, b) => (a.name || a.pin).localeCompare(b.name || b.pin))
  return { month, days, rows }
}

module.exports = { resolveDay, dailyRows, summaryRows, monthDays, timesheet }
