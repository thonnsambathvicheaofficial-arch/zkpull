const { allPunches, empMap } = require('../lib/supabase')
const { dailyRows, summaryRows } = require('../lib/attendance')
const { toXlsx } = require('../lib/excel')

const SETTINGS = { workStart: process.env.WORK_START || '08:00', graceMinutes: Number(process.env.GRACE_MIN || 5) }

module.exports = async (req, res) => {
  try {
    const kind = req.query.kind || 'daily'
    const emps = await empMap()
    const raw = await allPunches(req.query)
    const daily = dailyRows(raw.map(r => ({ pin: r.pin, time: r.ts })), emps, SETTINGS)

    let sheet
    if (kind === 'summary') {
      sheet = { name: 'Summary', header: ['PIN', 'Name', 'Days', 'Total Hours', 'Late Days'],
        rows: summaryRows(daily).map(r => [r.pin, r.name, r.days, r.hours, r.late]), cols: [12, 24, 8, 12, 10] }
    } else if (kind === 'punches') {
      sheet = { name: 'Punches', header: ['Date', 'Time', 'PIN', 'Name', 'Source', 'Verify'],
        rows: raw.map(p => [p.ts.slice(0, 10), p.ts.slice(11, 19), p.pin, emps[p.pin] || '', p.source, p.verify]), cols: [12, 10, 12, 24, 8, 8] }
    } else {
      sheet = { name: 'Daily', header: ['Date', 'PIN', 'Name', 'In', 'Lunch Out', 'Lunch In', 'Out', 'Hours', 'Punches', 'Late'],
        rows: daily.map(r => [r.date, r.pin, r.name, r.in, r.lunchOut, r.lunchIn, r.out, r.hours, r.punches, r.late ? 'LATE' : '']), cols: [12, 12, 24, 8, 10, 10, 8, 8, 9, 7] }
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="Attendance_${kind}_${new Date().toISOString().slice(0, 10)}.xlsx"`)
    res.send(toXlsx([sheet]))
  } catch (e) { res.status(500).json({ error: e.message }) }
}
