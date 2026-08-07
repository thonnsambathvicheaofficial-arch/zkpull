// Supabase data layer for the Vercel API routes. Uses the SERVICE key — these
// functions run server-side only, never in the browser.
const { createClient } = require('@supabase/supabase-js')

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

// Pull all matching punches, paging past Supabase's 1000-row cap.
async function allPunches(f = {}) {
  const out = []
  for (let from = 0; ; from += 1000) {
    let q = sb.from('punches').select('pin,ts,device_id,source,verify').order('ts', { ascending: true }).range(from, from + 999)
    if (f.from)     q = q.gte('ts', f.from + ' 00:00:00')
    if (f.to)       q = q.lte('ts', f.to + ' 23:59:59')
    if (f.deviceId) q = q.eq('device_id', f.deviceId)
    if (f.pin)      q = q.eq('pin', String(f.pin))
    const { data, error } = await q
    if (error) throw new Error(error.message)
    out.push(...(data || []))
    if ((data || []).length < 1000) break
  }
  return out
}

async function empMap() {
  const { data } = await sb.from('employees').select('pin,name')
  const m = {}
  for (const e of (data || [])) m[e.pin] = e.name
  return m
}

module.exports = { sb, allPunches, empMap }
