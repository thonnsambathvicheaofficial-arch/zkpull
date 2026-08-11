const { dailyRows } = require('../lib/attendance')

const punches = [
  { pin: '999', time: '2026-08-11 07:58:00' },
  { pin: '999', time: '2026-08-11 13:44:00' },
  { pin: '999', time: '2026-08-11 17:30:00' },
]
const employees = { '999': { name: 'Test', group: 'office', timeIn: '08:00', timeOut: '17:30', offDays: [0, 6] } }
const settings = { workStart: '08:00', workEnd: '17:30', graceMinutes: 5 }

const rows = dailyRows(punches, employees, settings, [], '2026-08-11', '2026-08-11')
const r = rows[0]
console.log('allPunches:', r && r.allPunches)
console.log('in:', r && r.in, '| out:', r && r.out)
console.log('punches count:', r && r.punches)
