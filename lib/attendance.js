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
// A driver's trip can run overnight/multi-day: IN one morning, OUT a later
// evening. Beyond MAX_SHIFT_HOURS, a still-open lone IN is allowed to pair with
// its closing OUT out to this cap (the shift is flagged multi-day so it's visible
// and auditable). A forgotten-punch IN→IN never qualifies — see buildSessions.
const MAX_TRIP_HOURS = 48

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

// Circular (wrap-around-midnight) distance in minutes between two times-of-day.
// 23:50 and 00:10 are 20 min apart, not 1420 — essential for night rules whose
// start/end straddle midnight (e.g. a 17:00→04:00 shift, or an end near 00:30).
const circDist = (a, b) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d) }
const todMin   = (s) => hhmmToMin(s.slice(11, 16))   // "…HH:MM…" -> minutes-of-day

// Collapse a scan list into work sessions (see header).
// Returns [{ in, out|null, count, outOnly? }] with in/out as "YYYY-MM-DD HH:MM:SS".
//
// Two time-aware corrections are applied when `rule` is supplied. Both measure a
// punch against the shift's OWN scheduled start/end (never absolute clock windows)
// and only ever refine what scan-order already decided:
//
//  1. SHIFT-BOUNDARY HANDOFF SPLIT: two consecutive scans that are really an
//     OUT closing one shift followed by an IN opening the next can fall inside
//     MAX_SHIFT_HOURS and get fused into one bogus shift. This happens both ways:
//       • DAY worker (driver): evening OUT (~17:00, back from a trip) then next
//         morning's IN (~04:20, leaving again), ~11 h apart — fused into a fake
//         17:00→04:20 overnight shift with IN/OUT reversed.
//       • NIGHT worker: dawn OUT (~04:00) then that same evening's IN (~17:00),
//         ~13 h apart — fused into a fake 04:00→17:00 "day".
//     We break between them when the earlier scan sits nearer the shift END and
//     the later nearer the shift START — an OUT-then-IN handoff, always a shift
//     boundary. The correct order for the rule (day IN→OUT, or night evening
//     IN→dawn OUT) has the earlier scan nearer START, so it is left intact.
//     Circular distance makes times either side of midnight compare correctly.
//
//  2. SINGLE-PUNCH CLASSIFICATION: when only one scan exists for a session, the
//     strict order rule always calls it an IN. But if that scan's time-of-day is
//     clearly closer to the END of the shift than the START, it is almost
//     certainly a missed-IN / lone OUT. We mark it { outOnly: true } so callers
//     can display OUT correctly without guessing a fake IN time.
function buildSessions(scanTimes, rule = null) {
  const sorted = [...scanTimes].sort()
  const scans = []
  for (const s of sorted) {
    if (!scans.length || diffSeconds(scans[scans.length - 1], s) >= DEDUP_SECONDS) scans.push(s)
  }
  const startMin = rule && rule.start ? hhmmToMin(rule.start) : null
  const endMin   = rule && rule.end   ? hhmmToMin(rule.end)   : null
  const haveRule = startMin !== null && endMin !== null
  const sessions = []
  let i = 0
  while (i < scans.length) {
    let j = i
    while (j + 1 < scans.length) {
      const gapFromSessionStart = diffMinutes(scans[i], scans[j + 1])
      // Role of the current tail and the next scan against THIS rule's start/end.
      const cur = haveRule ? todMin(scans[j])     : 0
      const next = haveRule ? todMin(scans[j + 1]) : 0
      const curIsEnd    = haveRule && circDist(cur, endMin)    < circDist(cur, startMin)
      const nextIsStart = haveRule && circDist(next, startMin) < circDist(next, endMin)
      // Shift-boundary handoff split (correction 1 — see header). Break on an
      // OUT-then-IN handoff: tail nearer the shift END, next nearer the START.
      // Works for both day and night rules (each punch judged against this rule).
      if (curIsEnd && nextIsStart) break
      if (gapFromSessionStart > MAX_SHIFT_HOURS * 60) {
        // Past a normal shift. Keep going ONLY to close a still-open trip: the
        // session tail is still a lone IN (start-region) and the next scan is its
        // closing OUT (end-region), within the multi-day trip cap. This pairs a
        // driver's overnight/multi-day trip (IN one morning → OUT a later evening)
        // into real hours. A forgotten-punch IN→IN fails this (next is start-
        // region) and a session that already reached its OUT fails it (tail is
        // end-region), so neither over-merges.
        const openInOnly = haveRule && !curIsEnd
        const nextIsEnd  = haveRule && !nextIsStart
        if (!(openInOnly && nextIsEnd && gapFromSessionStart <= MAX_TRIP_HOURS * 60)) break
      }
      j++
    }
    // Single-punch time-aware classification (correction 2 — see header).
    // Only applies when we have BOTH scheduled times to compare against.
    if (j === i && startMin !== null && endMin !== null) {
      const punchMin = todMin(scans[i])
      const distFromStart = circDist(punchMin, startMin)
      const distFromEnd   = circDist(punchMin, endMin)
      // Treat as OUT-only when:
      //  • punch is unambiguously closer to end time than start time, AND
      //  • it is within a 3-hour window around the scheduled end (not a midday stray)
      if (distFromEnd < distFromStart && distFromEnd <= 180) {
        sessions.push({ in: null, out: scans[i], count: 1, all: [scans[i]], outOnly: true })
        i = j + 1
        continue
      }
    }
    sessions.push({ in: scans[i], out: j > i ? scans[j] : null, count: j - i + 1, all: scans.slice(i, j + 1) })
    i = j + 1
  }
  return sessions
}

// Resolve one session (shift) into reportable fields. Worked hours = OUT - IN
// (the real span, crossing midnight when needed). Late/minutesLate judged on the
// IN vs the staff's Time In + grace. Lateness on a midnight-crossing shift, and
// early-leave, are only judged when the staff has custom times set — so a night
// worker on the daytime default isn't falsely flagged late/early.
//
// outOnly sessions (lone punch near end-of-shift) return in: null, hours: 0.
function resolveShift(s, rule) {
  // OUT-only: single scan classified as end-of-shift with no matching IN.
  // We know the worker was present (they scanned out) but cannot calculate
  // hours without the IN time. Show OUT, zero hours, skip late flags.
  if (s.outOnly) {
    return {
      in: null, out: hm(s.out), hours: 0,
      punches: s.count, allPunches: (s.all || []).map(hm),
      late: false, earlyLeave: false, minutesLate: 0, missingIn: true,
    }
  }

  const inF = s.in, outF = s.out
  const crossesMidnight = !!(outF && outF.slice(0, 10) !== inF.slice(0, 10))
  // Whole calendar days between the IN and OUT dates. 0 = same day, 1 = OUT next
  // morning (overnight), ≥2 = a multi-day trip. Drives the "+N day" report flag.
  const outDayOffset = outF ? Math.round((new Date(outF.slice(0, 10) + 'T00:00:00') - new Date(inF.slice(0, 10) + 'T00:00:00')) / 86400000) : 0
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

  // outNextDay/outDayOffset let the UI flag an OUT that lands on a later day — an
  // overnight OUT (offset 1) or a multi-day trip (offset ≥2) — so hours spanning
  // days are visible and a night-worker's evening-IN/dawn-OUT doesn't read as a swap.
  return { in: hm(inF), out: hm(outF), hours, punches: s.count, allPunches: (s.all || []).map(hm), late, earlyLeave, minutesLate, outNextDay: crossesMidnight, outDayOffset }
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

// Map every alias PIN -> its primary PIN (from employees[].aliases). Lets a
// person enrolled under different PINs on different devices (non-global PIN)
// roll up to ONE staff record — punches under any alias count as the primary.
function aliasToPrimary(employees) {
  const m = {}
  for (const pin of Object.keys(employees)) for (const a of (employees[pin].aliases || [])) m[a] = pin
  return m
}

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
  // Build shift sessions per staff (rolling alias PINs up to the primary), then
  // index each resolved shift by the calendar day its IN falls on.
  const alias = aliasToPrimary(employees)
  const timesByPin = new Map()
  for (const p of punches) {
    const pin = alias[p.pin] || p.pin
    if (!employees[pin]) continue
    if (!timesByPin.has(pin)) timesByPin.set(pin, [])
    timesByPin.get(pin).push(p.time)
  }
  const shiftByDay = new Map()   // "pin|date" -> resolved shift
  for (const [pin, times] of timesByPin) {
    const rule = ruleFor(pin, employees, settings)
    for (const s of buildSessions(times, rule)) {
      // outOnly sessions are attributed to the OUT date (no IN exists).
      const date = (s.in || s.out).slice(0, 10)
      const outDate = s.out ? s.out.slice(0, 10) : null

      // ── MIDNIGHT ROLLOVER ────────────────────────────────────────────────
      // When the OUT punch falls on a different calendar day AND the session is
      // longer than a normal shift (> MAX_SHIFT_HOURS), it's almost certainly a
      // mis-paired punch (an IN from one day incorrectly fused with an OUT from
      // a later day). We split it instead of showing "+N day":
      //   • The IN day gets a present/late shift with no OUT (missing OUT).
      //   • The OUT punch rolls over to its own date as an outOnly entry.
      //
      // Legitimate overnight shifts (e.g. 4 PM → 12:10 AM ≈ 8 h) also cross
      // midnight but their session duration is within MAX_SHIFT_HOURS — those
      // are left intact and shown normally on the IN date.
      const sessionMins = s.in && s.out ? diffMinutes(s.in, s.out) : 0
      if (s.in && outDate && outDate !== date && sessionMins > MAX_SHIFT_HOURS * 60) {
        // IN-side: resolved shift without the OUT
        const inOnlySession = { ...s, out: null }
        const inShift = resolveShift(inOnlySession, rule)
        // Force missingOut flag so the UI can indicate the OUT is on a later day
        inShift.missingOut = true
        inShift.outNextDay = false
        inShift.outDayOffset = 0

        const kIn = pin + '|' + date
        const curIn = shiftByDay.get(kIn)
        if (!curIn) {
          shiftByDay.set(kIn, inShift)
        } else {
          curIn.hours = Math.round((curIn.hours + inShift.hours) * 10) / 10
          curIn.punches += inShift.punches
          curIn.allPunches = [...(curIn.allPunches || []), ...(inShift.allPunches || [])]
          curIn.late = curIn.late || inShift.late
          curIn.earlyLeave = curIn.earlyLeave || inShift.earlyLeave
          curIn.minutesLate = Math.max(curIn.minutesLate, inShift.minutesLate)
        }

        // OUT-side: rolled over to the OUT's calendar day as an outOnly entry
        const outOnlySession = { in: null, out: s.out, count: 1, all: [s.out], outOnly: true }
        const outShift = resolveShift(outOnlySession, rule)
        const kOut = pin + '|' + outDate
        const curOut = shiftByDay.get(kOut)
        if (!curOut) {
          shiftByDay.set(kOut, outShift)
        } else {
          // Don't clobber a real IN-based shift already on that day
          // but do merge the OUT time in if the existing shift has no OUT yet
          if (!curOut.out) {
            curOut.out = outShift.out
            curOut.missingIn = false
          }
        }
        continue
      }
      // ── END MIDNIGHT ROLLOVER ────────────────────────────────────────────

      const shift = resolveShift(s, rule)
      const k = pin + '|' + date
      const cur = shiftByDay.get(k)
      if (!cur) shiftByDay.set(k, shift)
      else {
        // Rare: two shifts started the same calendar day — total the worked
        // hours (never the outer span, which would re-introduce the bug).
        cur.hours = Math.round((cur.hours + shift.hours) * 10) / 10
        cur.in = cur.in || shift.in
        cur.out = shift.out || cur.out
        cur.punches += shift.punches
        cur.allPunches = [...(cur.allPunches || []), ...(shift.allPunches || [])]
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
        let inT = null, outT = null, hours = 0, punchCount = 0, allPunches = [], outNextDay = false, outDayOffset = 0
        if (!zeroHours) {
          if (ov.timeIn && ov.timeOut) {
            inT = ov.timeIn; outT = ov.timeOut
            const mins = diffMinutes(`${date} ${ov.timeIn}:00`, `${date} ${ov.timeOut}:00`)
            hours = Math.max(0, Math.round(mins / 6) / 10)
            allPunches = [`${date} ${ov.timeIn}:00`, `${date} ${ov.timeOut}:00`]
          } else if (shift) {
            inT = shift.in; outT = shift.out; hours = shift.hours; punchCount = shift.punches; allPunches = shift.allPunches || []; outNextDay = !!shift.outNextDay; outDayOffset = shift.outDayOffset || 0
          }
        }
        rows.push({ ...base, status: ov.status, in: inT, out: outT, hours, punches: punchCount, allPunches, outNextDay, outDayOffset,
          late: false, earlyLeave: false, minutesLate: 0, note: ov.note, overridden: true })
      } else if (shift) {
        rows.push({ ...base, status: shift.late ? 'late' : 'present', ...shift, note: null, overridden: false })
      } else {
        const dow = new Date(date + 'T00:00:00').getDay()
        const isDayOff = offDays.includes(dow)
        rows.push({ ...base, status: isDayOff ? 'day_off' : 'absent',
          in: null, out: null, hours: 0, punches: 0, allPunches: [], late: false, earlyLeave: false, minutesLate: 0,
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

module.exports = { buildSessions, resolveShift, dailyRows, summaryRows, monthDays, timesheet, aliasToPrimary }
