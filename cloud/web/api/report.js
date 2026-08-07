const { allPunches, empMap } = require('../lib/supabase')
const { dailyRows, summaryRows } = require('../lib/attendance')

const SETTINGS = { workStart: process.env.WORK_START || '08:00', graceMinutes: Number(process.env.GRACE_MIN || 5) }

module.exports = async (req, res) => {
  try {
    const kind = req.query.kind || 'daily'
    const punches = (await allPunches(req.query)).map(r => ({ pin: r.pin, time: r.ts }))
    const daily = dailyRows(punches, await empMap(), SETTINGS)
    res.json(kind === 'summary' ? summaryRows(daily) : daily)
  } catch (e) { res.status(500).json({ error: e.message }) }
}
