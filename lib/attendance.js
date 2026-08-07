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

// "YYYY-MM-DD" for every day in [from, to] inclusive, in LOCAL time (matches
// the rest of this app — no timezone conversion; the whole system assumes the
// server clock is already set to the devices' own timezone, per the README).
function enumerateDates(from, to) {
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const out = []
  const cur = new Date(from + 'T00:00:00')
  const end = new Date(to + 'T00:00:00')
  while (cur <= end) { out.push(fmt(cur)); cur.setDate(cur.getDate() + 1) }
  return out
}

// Statuses that count as a worked day for hours/day totals. 'late' is a
// worked day too (just late), so it's included alongside 'present'/'excused'.
const PRESENT_FAMILY = new Set(['present', 'late', 'excused'])

// One row per (pin, date) for EVERY day in [from, to] and EVERY staff member
// in `employees` — the report is now fully accounted for, not just a log of
// days that happened to have a scan. Priority, highest first:
//   1. day_overrides (manual, the final source of truth — see schema.sql)
//   2. actual punches that day (worked, on-time or late)
//   3. the staff's weekly off-days pattern (routine day off, no override needed)
//   4. otherwise: a workday with no scan and no override = genuinely absent
//
// `overrides` is the flat list from store.overrides.query({from, to}) — every
// (pin, date) row it returns beats whatever punches/off-days would say.
function dailyRows(punches, employees, settings, overrides, from, to) {
  const byDay = new Map()   // "pin|date" -> punches that day
  for (const p of punches) {
    if (!employees[p.pin]) continue
    const k = p.pin + '|' + p.time.slice(0, 10)
    if (!byDay.has(k)) byDay.set(k, [])
    byDay.get(k).push(p)
  }
  const ovByDay = new Map()   // "pin|date" -> override row
  for (const o of (overrides || [])) ovByDay.set(o.pin + '|' + o.date, o)

  const dates = enumerateDates(from, to)
  const rows = []
  for (const pin of Object.keys(employees)) {
    const e = employees[pin]
    const offDays = e.offDays && e.offDays.length ? e.offDays : [0, 6]
    for (const date of dates) {
      const k = pin + '|' + date
      const ps = byDay.get(k)
      const ov = ovByDay.get(k)
      const base = { pin, name: e.name || '', group: e.group || null, date }

      if (ov) {
        // Manual override wins outright. 'day_off'/'leave' always zero the
        // hours (they shouldn't have worked). Otherwise: a manually-entered
        // time_in/time_out (e.g. correcting a bad/missing scan) takes
        // priority over real punch times; falls back to real punches if any;
        // falls back to 0 hours if neither exists (present/excused with no
        // known times — still not flagged as a problem, just no hours logged).
        const zeroHours = ov.status === 'day_off' || ov.status === 'leave'
        let inT = null, outT = null, hours = 0, punchCount = 0
        if (!zeroHours) {
          if (ov.timeIn && ov.timeOut) {
            inT = ov.timeIn; outT = ov.timeOut
            const mins = diffMinutes(`${date} ${ov.timeIn}:00`, `${date} ${ov.timeOut}:00`)
            hours = Math.max(0, Math.round(mins / 6) / 10)
          } else if (ps) {
            const day = resolveDay(ps, ruleFor(pin, employees, settings))
            inT = day.in; outT = day.out; hours = day.hours; punchCount = day.punches
          }
        }
        rows.push({ ...base, status: ov.status, in: inT, out: outT, hours, punches: punchCount,
          late: false, earlyLeave: false, note: ov.note, overridden: true })
      } else if (ps) {
        const day = resolveDay(ps, ruleFor(pin, employees, settings))
        rows.push({ ...base, status: day.late ? 'late' : 'present', ...day, note: null, overridden: false })
      } else {
        const dow = new Date(date + 'T00:00:00').getDay()
        const isDayOff = offDays.includes(dow)
        rows.push({ ...base, status: isDayOff ? 'day_off' : 'absent',
          in: null, out: null, hours: 0, punches: 0, late: false, earlyLeave: false,
          note: null, overridden: false })
      }
    }
  }
  // Grouped by staff (then date within each staff) — easier to review one
  // person's full history in one block, whether on-screen or exported.
  rows.sort((a, b) => (a.name || a.pin).localeCompare(b.name || b.pin) || a.date.localeCompare(b.date))
  return rows
}

// One row per employee across the range.
function summaryRows(daily) {
  const m = new Map()
  for (const r of daily) {
    if (!m.has(r.pin)) m.set(r.pin, { pin: r.pin, name: r.name, group: r.group, days: 0, hours: 0, late: 0, early: 0, absent: 0, dayOff: 0, leave: 0, excused: 0 })
    const o = m.get(r.pin)
    if (PRESENT_FAMILY.has(r.status)) { o.days++; o.hours += r.hours }
    if (r.status === 'late') o.late++
    if (r.earlyLeave) o.early++
    if (r.status === 'absent') o.absent++
    if (r.status === 'day_off') o.dayOff++
    if (r.status === 'leave') o.leave++
    if (r.status === 'excused') o.excused++
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
// Every day of the month now gets a cell — worked, day off, absent, or
// overridden — since dailyRows() walks the full range itself; this just pivots.
function timesheet(punches, employees, settings, overrides, month) {
  const days = monthDays(month)
  const from = `${month}-01`
  const to = `${month}-${String(days.length).padStart(2, '0')}`
  const daily = dailyRows(punches, employees, settings, overrides, from, to)
  const byPin = new Map()
  for (const r of daily) {
    if (!byPin.has(r.pin)) byPin.set(r.pin, { pin: r.pin, name: r.name || (employees[r.pin] && employees[r.pin].name) || '', group: r.group, cells: {}, totalHours: 0, daysPresent: 0, lateDays: 0, earlyDays: 0 })
    const o = byPin.get(r.pin)
    o.cells[Number(r.date.slice(8, 10))] = { status: r.status, hours: r.hours, late: r.status === 'late', earlyLeave: r.earlyLeave, in: r.in, out: r.out, note: r.note, overridden: r.overridden }
    if (PRESENT_FAMILY.has(r.status)) { o.totalHours += r.hours; o.daysPresent += 1 }
    if (r.status === 'late') o.lateDays += 1
    if (r.earlyLeave) o.earlyDays += 1
  }
  const rows = [...byPin.values()]
    .map(o => ({ ...o, totalHours: Math.round(o.totalHours * 10) / 10 }))
    .sort((a, b) => (a.name || a.pin).localeCompare(b.name || b.pin))
  return { month, days, rows }
}

module.exports = { resolveDay, dailyRows, summaryRows, monthDays, timesheet }
