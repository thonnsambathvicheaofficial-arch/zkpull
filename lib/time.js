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

const hhmmToMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m }

module.exports = { fmtLocal, dateOf, hm, diffMinutes, hhmmToMin, pad }
