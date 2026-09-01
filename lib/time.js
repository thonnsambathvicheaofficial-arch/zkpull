// Timezone-safe helpers.
//
// HARD-WON LESSON from the HRM: ZKTeco devices report NAIVE wall-clock time in
// their local zone (Cambodia / ICT). node-zklib hands that back as a Date. If
// this app runs on a machine whose clock is set to the SAME zone as the devices
// (which it should be — run it on-site or on a PC set to ICT), formatting that
// Date with LOCAL getters reproduces the exact wall-clock the device showed.
// We therefore store every punch as a plain local string "YYYY-MM-DD HH:MM:SS"
// and never apply a second timezone conversion.

const pad = n => String(n).padStart(2, '0')

// Date -> "YYYY-MM-DD HH:MM:SS" in the machine's local time
function fmtLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const dateOf = s => s.slice(0, 10)          // "YYYY-MM-DD"
const hm     = s => (s ? s.slice(11, 16) : '') // "HH:MM"

// Minutes between two "YYYY-MM-DD HH:MM:SS" strings (both local, same basis)
function diffMinutes(a, b) {
  return (new Date(b.replace(' ', 'T')) - new Date(a.replace(' ', 'T'))) / 60000
}
// Seconds between two "YYYY-MM-DD HH:MM:SS" strings — used to collapse accidental
// rapid re-scans (a staff tapping the reader twice within seconds).
function diffSeconds(a, b) {
  return (new Date(b.replace(' ', 'T')) - new Date(a.replace(' ', 'T'))) / 1000
}

const hhmmToMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m }

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// "YYYY-MM-DD" -> weekday name. Builds the Date from local Y/M/D components
// (not the string-parsing constructor, which treats "YYYY-MM-DD" as UTC
// midnight and can shift the weekday depending on the machine's timezone) —
// a calendar weekday is a pure date fact and shouldn't move with the clock.
function dayName(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()]
}

// "HH:MM" or "HH:MM:SS" (24h) -> "h:MM AM/PM" for display/exports. Blank passes through.
function to12h(t) {
  if (!t) return ''
  const p = String(t).split(':')
  let h = parseInt(p[0], 10); if (isNaN(h)) return t
  const ap = h < 12 ? 'AM' : 'PM'
  h = h % 12 || 12
  return `${h}:${p.slice(1).join(':')} ${ap}`
}

module.exports = { fmtLocal, dateOf, hm, diffMinutes, diffSeconds, hhmmToMin, to12h, dayName, pad }
