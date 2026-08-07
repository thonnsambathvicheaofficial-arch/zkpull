const { allPunches, empMap } = require('../lib/supabase')

module.exports = async (req, res) => {
  try {
    const emps = await empMap()
    const rows = (await allPunches(req.query)).map(p => ({ ...p, time: p.ts, name: emps[p.pin] || '' }))
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
}
