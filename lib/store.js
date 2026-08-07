// Supabase-backed store. Same shapes the rest of the app (server.js,
// lib/attendance.js) already expects — employees keyed by pin with
// {name, group, timeIn, timeOut}, settings as {timezone, workStart, workEnd,
// graceMinutes} — so only this file needed to change when the storage moved
// from local ./data/*.json to Supabase. Every call is now async.
//
// Punches are written exclusively by cloud/agent (the on-site puller) — this
// app only ever reads them, plus manages devices/employees/settings/logins.

const sb = require('./supabase')

const toEmployee = (row) => ({ name: row.name || '', group: row.group || null, timeIn: row.time_in || null, timeOut: row.time_out || null })
const toSettings = (row) => ({ timezone: row.timezone, workStart: row.work_start, workEnd: row.work_end, graceMinutes: row.grace_minutes })

// Page past Supabase/PostgREST's 1000-row default cap.
async function selectAll(table, build) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table)).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data || []))
    if ((data || []).length < 1000) break
  }
  return out
}

module.exports = {
  devices: {
    list: async () => {
      const { data, error } = await sb.from('devices').select('*').order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      return data.map(d => ({ id: d.id, createdAt: d.created_at, name: d.name, type: d.type, ip: d.ip, port: d.port, serial: d.serial }))
    },
    get: async (id) => {
      const { data, error } = await sb.from('devices').select('*').eq('id', id).maybeSingle()
      if (error) throw new Error(error.message)
      return data ? { id: data.id, createdAt: data.created_at, name: data.name, type: data.type, ip: data.ip, port: data.port, serial: data.serial } : null
    },
    add: async (d) => {
      const { data, error } = await sb.from('devices')
        .insert({ name: d.name, type: d.type, ip: d.ip || null, port: d.port || 4370, serial: d.serial || null })
        .select().single()
      if (error) throw new Error(error.message)
      return { id: data.id, createdAt: data.created_at, name: data.name, type: data.type, ip: data.ip, port: data.port, serial: data.serial }
    },
    update: async (id, patch) => {
      const row = {}
      if ('name' in patch) row.name = patch.name
      if ('type' in patch) row.type = patch.type
      if ('ip' in patch) row.ip = patch.ip
      if ('port' in patch) row.port = patch.port
      if ('serial' in patch) row.serial = patch.serial
      const { data, error } = await sb.from('devices').update(row).eq('id', id).select().maybeSingle()
      if (error) throw new Error(error.message)
      return data ? { id: data.id, createdAt: data.created_at, name: data.name, type: data.type, ip: data.ip, port: data.port, serial: data.serial } : null
    },
    remove: async (id) => { const { error } = await sb.from('devices').delete().eq('id', id); if (error) throw new Error(error.message) },
  },

  punches: {
    count: async () => {
      const { count, error } = await sb.from('punches').select('*', { count: 'exact', head: true })
      if (error) throw new Error(error.message)
      return count || 0
    },
    // { deviceId: count } — a real GROUP BY view (device_punch_counts), not a
    // client-side count over every punch row (that was the Devices page's
    // "empty for several seconds" bug: 65+ sequential paginated requests just
    // to count 65k rows, right up against Vercel's serverless timeout).
    countsByDevice: async () => {
      const { data, error } = await sb.from('device_punch_counts').select('device_id,n')
      if (error) throw new Error(error.message)
      return Object.fromEntries(data.map(r => [r.device_id, r.n]))
    },
    // f: { deviceId, from, to, pin } -> [{ id, deviceId, serial, pin, time, verify, status, source }]
    query: async (f = {}) => {
      const rows = await selectAll('punches', (q) => {
        q = q.select('id,device_id,serial,pin,ts,verify,status,source').order('ts', { ascending: true })
        if (f.deviceId) q = q.eq('device_id', f.deviceId)
        if (f.from) q = q.gte('ts', `${f.from} 00:00:00`)
        if (f.to) q = q.lte('ts', `${f.to} 23:59:59`)
        if (f.pin) q = q.eq('pin', String(f.pin))
        return q
      })
      return rows.map(r => ({ id: r.id, deviceId: r.device_id, serial: r.serial, pin: r.pin, time: r.ts.replace('T', ' ').slice(0, 19), verify: r.verify, status: r.status, source: r.source }))
    },
  },

  employees: {
    get: async () => {
      const { data, error } = await sb.from('employees').select('*')
      if (error) throw new Error(error.message)
      const out = {}
      for (const row of data) out[row.pin] = toEmployee(row)
      return out
    },
    names: async () => {
      const { data, error } = await sb.from('employees').select('pin,name')
      if (error) throw new Error(error.message)
      return Object.fromEntries(data.map(r => [r.pin, r.name || '']))
    },
    // Explicit empty-string name removes the PIN (matches old local-store behavior).
    set: async (pin, data) => {
      const name = data && typeof data.name === 'string' ? data.name.trim() : undefined
      if (name === '') { const { error } = await sb.from('employees').delete().eq('pin', pin); if (error) throw new Error(error.message); return }
      const { data: cur } = await sb.from('employees').select('*').eq('pin', pin).maybeSingle()
      const curE = cur ? toEmployee(cur) : { name: '', group: null, timeIn: null, timeOut: null }
      const row = {
        pin,
        name: name !== undefined ? name : curE.name,
        group: data && 'group' in data ? (data.group || null) : curE.group,
        time_in: data && 'timeIn' in data ? (data.timeIn || null) : curE.timeIn,
        time_out: data && 'timeOut' in data ? (data.timeOut || null) : curE.timeOut,
      }
      const { error } = await sb.from('employees').upsert(row, { onConflict: 'pin' })
      if (error) throw new Error(error.message)
    },
  },

  settings: {
    get: async () => {
      const { data, error } = await sb.from('settings').select('*').eq('id', 1).single()
      if (error) throw new Error(error.message)
      return toSettings(data)
    },
    set: async (patch) => {
      const row = {}
      if ('timezone' in patch) row.timezone = patch.timezone
      if ('workStart' in patch) row.work_start = patch.workStart
      if ('workEnd' in patch) row.work_end = patch.workEnd
      if ('graceMinutes' in patch) row.grace_minutes = patch.graceMinutes
      const { data, error } = await sb.from('settings').update(row).eq('id', 1).select().single()
      if (error) throw new Error(error.message)
      return toSettings(data)
    },
  },
}
