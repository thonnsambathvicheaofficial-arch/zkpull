// Turn raw punches into daily attendance — the core reporting logic.
//
// PUNCH SLOTTING (hard-won rule): a shift's punches are resolved by SCAN ORDER,
// never by absolute time-of-day windows. Staff punch IN and OUT only (no lunch),
// so within a work session the FIRST scan is IN and the LAST is OUT; any scans
// between (retries, stray taps) are ignored for hours but still counted.
//
// SESSIONS (factory shift work, incl. nights crossing midnight): punches are
// grouped into work sessions by TIME GAP, not by calendar day. A session is a
// run of scans all within MAX_SHIFT_HOURS of the session's first scan; the next
// scan beyond that starts a new session. Each session = one shift, attributed to
// the calendar day its IN falls on — so a 16:00→00:30 night shift is ONE ~8.5h
// shift on its start date, not two broken calendar days (the old 16h bug).
//
// DEDUP: an accidental double-tap (reader beeps, worker re-scans a few seconds
// later) is one event, not an in+out — scans within DEDUP_SECONDS of the
// previous kept scan are collapsed.

const { hm, diffMinutes, diffSeconds, hhmmToMin } = require('./time')

// Accidental re-scans happen within seconds; a real IN and OUT are hours apart,
// so this window only ever merges genuine double-taps.
const DEDUP_SECONDS = 120
// A single shift (+ reasonable overtime) can't plausibly exceed this. A later
// scan beyond this gap from the session start begins a NEW shift; a lone IN with
// nothing within it means the worker forgot to scan out (missing OUT).
const MAX_SHIFT_HOURS = 16

// The effective punch rule for a staff member: their own Time In / Time Out
// (set on the Staff page), or the global defaults (Settings) when unset.
// hasCustomStart/End record whether the staff set their OWN times — used to
// avoid judging a night worker's lateness against the daytime default.
function ruleFor(pin, employees, settings) {
  const e = employees[pin]
  return {
    start: (e && e.timeIn) || settings.workStart,
    end: (e && e.timeOut) || settings.workEnd,
    grace: Number(settings.graceMinutes) || 0,
    hasCustomStart: !!(e && e.timeIn),
    hasCustomEnd: !!(e && e.timeOut),
  }
}

// Collapse a scan list into work sessions (see header).
// Returns [{ in, out|null, count }] with in/out as "YYYY-MM-DD HH:MM:SS".
function buildSessions(scanTimes) {
  const sorted = [...scanTimes].sort()
  const scans = []
  for (const s of sorted) {
    if (!scans.length || diffSeconds(scans[scans.length - 1], s) >= DEDUP_SECONDS) scans.push(s)
  }
  const sessions = []
  let i = 0
  while (i < scans.length) {
    let j = i
    while (j + 1 < scans.length && diffMinutes(scans[i], scans[j + 1]) <= MAX_SHIFT_HOURS * 60) j++
    sessions.push({ in: scans[i], out: j > i ? scans[j] : null, count: j - i + 1 })
    i = j + 1
  }
  return sessions
}

// Resolve one session (shift) into reportable fields. Worked hours = OUT - IN
// (the real span, crossing midnight when needed). Late/minutesLate judged on the
// IN vs the staff's Time In + grace. Lateness on a midnight-crossing shift, and
// early-leave, are only judged when the staff has custom times set — so a night
// worker on the daytime default isn't falsely flagged late/early.
function resolveShift(s, rule) {
  const inF = s.in, outF = s.out
  const crossesMidnight = !!(outF && outF.slice(0, 10) !== inF.slice(0, 10))
  const mins = outF ? diffMinutes(inF, outF) : 0
  const hours = Math.max(0, Math.round(mins / 6) / 10)   // 1-decimal hours

  let late = false, minutesLate = 0
  if (rule.start && (!crossesMidnight || rule.hasCustomStart)) {
    const inMin = hhmmToMin(inF.slice(11, 16))
    // Grace deadline = scheduled start + grace. Late, and minutes-late, are both
    // measured from this deadline — an 08:07 in with an 08:00 start and 5-min
    // grace is 2 min late, not 7.
    const deadline = hhmmToMin(rule.start) + (Number(rule.grace) || 0)
    late = inMin > deadline
    if (late) minutesLate = inMin - deadline
  }

  let earlyLeave = false
  if (rule.end && outF && (!crossesMidnight || rule.hasCustomEnd)) {
    const outMin = hhmmToMin(outF.slice(11, 16))
    earlyLeave = outMin < hhmmToMin(rule.end) - (Number(rule.grace) || 0)
  }

  return { in: hm(inF), out: hm(outF), hours, punches: s.count, late, earlyLeave, minutesLate }
}

// "YYYY-MM-DD" for every day in [from, to] inclusive, in LOCAL time.
function enumerateDates(from, to) {
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const out = []
  const cur = new Date(from + 'T00:00:00')
  const end = new Date(to + 'T00:00:00')
  while (cur <= end) { out.push(fmt(cur)); cur.setDate(cur.getDate() + 1) }
  return out
}

// Statuses that count as a worked day for hours/day totals.
const PRESENT_FAMILY = new Set(['present', 'late', 'excused'])

// One row per (pin, date) for EVERY day in [from, to] and EVERY staff member.
// Priority, highest first:
//   1. day_overrides (manual, the final source of truth)
//   2. the SHIFT whose IN falls on that day (worked, on-time or late)
//   3. the staff's weekly off-days pattern (routine day off)
//   4. otherwise: a workday with no shift and no override = genuinely absent
//
// NOTE: the caller passes `punches` covering a ±1 day margin around [from, to]
// so shifts crossing the range edges pair correctly; rows are emitted only for
// [from, to].
function dailyRows(punches, employees, settings, overrides, from, to) {
  // Build shift sessions per staff, then index each resolved shift by the
  // calendar day its IN falls on.
  const timesByPin = new Map()
  for (const p of punches) {
    if (!employees[p.pin]) continue
    if (!timesByPin.has(p.pin)) timesByPin.set(p.pin, [])
    timesByPin.get(p.pin).push(p.time)
  }
  const shiftByDay = new Map()   // "pin|date" -> resolved shift
  for (const [pin, times] of timesByPin) {
    const rule = ruleFor(pin, employees, settings)
    for (const s of buildSessions(times)) {
      const date = s.in.slice(0, 10)
      const shift = resolveShift(s, rule)
      const k = pin + '|' + date
      const cur = shiftByDay.get(k)
      if (!cur) shiftByDay.set(k, shift)
      else {
        // Rare: two shifts started the same calendar day — total the worked
        // hours (never the outer span, which would re-introduce the bug).
        cur.hours = Math.round((cur.hours + shift.hours) * 10) / 10
        cur.out = shift.out || cur.out
        cur.punches += shift.punches
        cur.late = cur.late || shift.late
        cur.earlyLeave = cur.earlyLeave || shift.earlyLeave
        cur.minutesLate = Math.max(cur.minutesLate, shift.minutesLate)
      }
    }
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
      const shift = shiftByDay.get(k)
      const ov = ovByDay.get(k)
      const base = { pin, name: e.name || '', group: e.group || null, date }

      if (ov) {
        // Manual override wins outright. 'day_off'/'leave' zero the hours.
        // Otherwise a manual time_in/time_out beats the shift, falling back to
        // the real shift, then to 0 hours.
        const zeroHours = ov.status === 'day_off' || ov.status === 'leave'
        let inT = null, outT = null, hours = 0, punchCount = 0
        if (!zeroHours) {
          if (ov.timeIn && ov.timeOut) {
            inT = ov.timeIn; outT = ov.timeOut
            const mins = diffMinutes(`${date} ${ov.timeIn}:00`, `${date} ${ov.timeOut}:00`)
            hours = Math.max(0, Math.round(mins / 6) / 10)
          } else if (shift) {
            inT = shift.in; outT = shift.out; hours = shift.hours; punchCount = shift.punches
          }
        }
        rows.push({ ...base, status: ov.status, in: inT, out: outT, hours, punches: punchCount,
          late: false, earlyLeave: false, minutesLate: 0, note: ov.note, overridden: true })
      } else if (shift) {
        rows.push({ ...base, status: shift.late ? 'late' : 'present', ...shift, note: null, overridden: false })
      } else {
        const dow = new Date(date + 'T00:00:00').getDay()
        const isDayOff = offDays.includes(dow)
        rows.push({ ...base, status: isDayOff ? 'day_off' : 'absent',
          in: null, out: null, hours: 0, punches: 0, late: false, earlyLeave: false, minutesLate: 0,
          note: null, overridden: false })
      }
    }
  }
  // Grouped by staff (then date within each staff).
  rows.sort((a, b) => (a.name || a.pin).localeCompare(b.name || b.pin) || a.date.localeCompare(b.date))
  return rows
}

// One row per employee across the range.
function summaryRows(daily) {
  const m = new Map()
  for (const r of daily) {
    if (!m.has(r.pin)) m.set(r.pin, { pin: r.pin, name: r.name, group: r.group, days: 0, hours: 0, late: 0, minLate: 0, early: 0, absent: 0, dayOff: 0, leave: 0, excused: 0 })
    const o = m.get(r.pin)
    if (PRESENT_FAMILY.has(r.status)) { o.days++; o.hours += r.hours }
    if (r.status === 'late') { o.late++; o.minLate += r.minutesLate || 0 }
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

module.exports = { buildSessions, resolveShift, dailyRows, summaryRows, monthDays, timesheet }
