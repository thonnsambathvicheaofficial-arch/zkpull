const { sb } = require('../lib/supabase')

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      const { name, type, ip, port, serial } = req.body || {}
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' })
      if ((type || 'pull') === 'pull' && !ip) return res.status(400).json({ error: 'IP is required for a TCP-pull device.' })
      const { data, error } = await sb.from('devices').insert({
        name: name.trim(), type: type === 'adms' ? 'adms' : 'pull',
        ip: (ip || '').trim() || null, port: Number(port) || 4370, serial: (serial || '').trim() || null,
      }).select().single()
      if (error) return res.status(500).json({ error: error.message })
      return res.json(data)
    }
    if (req.method === 'DELETE') { await sb.from('devices').delete().eq('id', req.query.id); return res.json({ ok: true }) }

    // GET — devices with punch counts
    const { data: devs } = await sb.from('devices').select('*').order('created_at')
    const list = devs || []
    for (const d of list) {
      const { count } = await sb.from('punches').select('*', { count: 'exact', head: true }).eq('device_id', d.id)
      d.punches = count || 0
    }
    res.json(list)
  } catch (e) { res.status(500).json({ error: e.message }) }
}
