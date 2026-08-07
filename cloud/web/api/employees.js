const { sb, empMap } = require('../lib/supabase')

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      const { pin, name } = req.body || {}
      if (!pin) return res.status(400).json({ error: 'PIN is required.' })
      if (name && name.trim()) await sb.from('employees').upsert({ pin: String(pin), name: name.trim() })
      else await sb.from('employees').delete().eq('pin', String(pin))
      return res.json({ ok: true })
    }
    res.json(await empMap())
  } catch (e) { res.status(500).json({ error: e.message }) }
}
