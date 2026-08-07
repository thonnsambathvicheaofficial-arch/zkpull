const { sb } = require('../lib/supabase')

module.exports = async (req, res) => {
  try {
    const [p, d] = await Promise.all([
      sb.from('punches').select('*', { count: 'exact', head: true }),
      sb.from('devices').select('*', { count: 'exact', head: true }),
    ])
    res.json({ ok: true, punches: p.count || 0, devices: d.count || 0 })
  } catch (e) { res.status(500).json({ error: e.message }) }
}
