// Supabase-backed store. Same shapes the rest of the app (server.js,
// lib/attendance.js) already expects — employees keyed by pin with
// {name, group, timeIn, timeOut}, settings as {timezone, workStart, workEnd,
// graceMinutes} — so only this file needed to change when the storage moved
// from local ./data/*.json to Supabase. Every call is now async.
//
// Punches are written by the background WAN puller — this web app only reads them
// for reports, except when deleting all data for a device reset.

const sb = require('./supabase')

const toDevice = (d) => ({
  id: d.id, createdAt: d.created_at, name: d.name, type: d.type, ip: d.ip, port: d.port, serial: d.serial,
  lastPullAt: d.last_pull_at, lastPullOk: d.last_pull_ok, lastPullError: d.last_pull_error, lastPullCount: d.last_pull_count,
  publicHost: d.public_host || null, publicPort: d.public_port || null,
})
const toEmployee = (row) => ({
  name: row.name || '', group: row.group || null, timeIn: row.time_in || null, timeOut: row.time_out || null,
  offDays: Array.isArray(row.off_days) && row.off_days.length ? row.off_days : [0, 6],
})
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
      return data.map(toDevice)
    },
    get: async (id) => {
      const { data, error } = await sb.from('devices').select('*').eq('id', id).maybeSingle()
      if (error) throw new Error(error.message)
      return data ? toDevice(data) : null
    },
    add: async (d) => {
      const { data, error } = await sb.from('devices')
        .insert({ name: d.name, type: d.type, ip: d.ip || null, port: d.port || 4370, serial: d.serial || null })
        .select().single()
      if (error) throw new Error(error.message)
      return toDevice(data)
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
      return data ? toDevice(data) : null
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
    // [{ pin, total, lastSeen }] — one row per distinct PIN (pin_activity view).
    // Used by the staff-suggestion tool to find actively-punching PINs cheaply.
    pinActivity: async () => {
      const { data, error } = await sb.from('pin_activity').select('pin,total,last_seen')
      if (error) throw new Error(error.message)
      return data.map(r => ({ pin: r.pin, total: r.total, lastSeen: r.last_seen }))
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

  // Cached device enrollment names (device_users table), refreshed by the
  // puller — read instantly by the staff-suggestion tool instead of dialing.
  deviceUsers: {
    getCache: async () => {
      const { data, error } = await sb.from('device_users').select('pin,name,devices')
      if (error) throw new Error(error.message)
      const out = {}
      for (const r of data) out[r.pin] = { name: r.name || '', devices: r.devices ? r.devices.split('+') : [] }
      return out
    },
    // Minutes since the freshest cache row (Infinity when empty) — the puller
    // uses this to decide when to refresh.
    ageMinutes: async () => {
      const { data, error } = await sb.from('device_users').select('updated_at').order('updated_at', { ascending: false }).limit(1)
      if (error) throw new Error(error.message)
      if (!data.length) return Infinity
      return (Date.now() - new Date(data[0].updated_at).getTime()) / 60000
    },
    upsert: async (rows) => {
      if (!rows.length) return 0
      const { error } = await sb.from('device_users').upsert(rows, { onConflict: 'pin' })
      if (error) throw new Error(error.message)
      return rows.length
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
    // data.newPin renames the PIN (it's the primary key) — punches and
    // day_overrides already recorded under the old PIN move with it, so
    // correcting a mistyped PIN doesn't orphan that person's history.
    set: async (pin, data) => {
      const name = data && typeof data.name === 'string' ? data.name.trim() : undefined
      if (name === '') { const { error } = await sb.from('employees').delete().eq('pin', pin); if (error) throw new Error(error.message); return }
      const { data: cur } = await sb.from('employees').select('*').eq('pin', pin).maybeSingle()
      const curE = cur ? toEmployee(cur) : { name: '', group: null, timeIn: null, timeOut: null, offDays: [0, 6] }

      const newPin = data && data.newPin != null ? String(data.newPin).trim() : null
      const renaming = !!(newPin && newPin !== pin)
      if (renaming) {
        const { data: taken } = await sb.from('employees').select('pin').eq('pin', newPin).maybeSingle()
        if (taken) throw new Error(`PIN ${newPin} is already used by another staff member.`)
      }
      const targetPin = renaming ? newPin : pin

      const row = {
        pin: targetPin,
        name: name !== undefined ? name : curE.name,
        group: data && 'group' in data ? (data.group || null) : curE.group,
        time_in: data && 'timeIn' in data ? (data.timeIn || null) : curE.timeIn,
        time_out: data && 'timeOut' in data ? (data.timeOut || null) : curE.timeOut,
        off_days: data && 'offDays' in data && Array.isArray(data.offDays) ? data.offDays : curE.offDays,
      }
      const { error } = await sb.from('employees').upsert(row, { onConflict: 'pin' })
      if (error) throw new Error(error.message)

      if (renaming && cur) {
        // Re-point history to the corrected PIN first, then drop the old
        // employee row last — if a step fails partway (e.g. the new PIN
        // already has an override on the same date as an old one), the old
        // row still exists so nothing about this person is silently lost.
        const { error: pErr } = await sb.from('punches').update({ pin: targetPin }).eq('pin', pin)
        if (pErr) throw new Error(`Renamed the PIN but couldn't move punch history: ${pErr.message}`)
        const { error: oErr } = await sb.from('day_overrides').update({ pin: targetPin }).eq('pin', pin)
        if (oErr) throw new Error(`Renamed the PIN but couldn't move day overrides: ${oErr.message}`)
        const { error: dErr } = await sb.from('employees').delete().eq('pin', pin)
        if (dErr) throw new Error(dErr.message)
      }
    },
  },

  // Manual day-level overrides — see cloud/supabase/schema.sql day_overrides
  // for the full rationale. `note` is required by the DB check constraint.
  overrides: {
    // f: { from, to, pin? } -> [{ pin, date, status, note, timeIn, timeOut, setBy, setAt }]
    query: async (f = {}) => {
      const rows = await selectAll('day_overrides', (q) => {
        q = q.select('*')
        if (f.from) q = q.gte('date', f.from)
        if (f.to) q = q.lte('date', f.to)
        if (f.pin) q = q.eq('pin', String(f.pin))
        return q
      })
      return rows.map(r => ({ pin: r.pin, date: r.date, status: r.status, note: r.note, timeIn: r.time_in, timeOut: r.time_out, setBy: r.set_by, setAt: r.set_at }))
    },
    // timeIn/timeOut ("HH:MM") are optional — a manual correction/record for a
    // bad or missing scan. Ignored by dailyRows() for 'day_off'/'leave'.
    set: async (pin, date, status, note, setBy, timeIn, timeOut) => {
      const { error } = await sb.from('day_overrides')
        .upsert({ pin, date, status, note, time_in: timeIn || null, time_out: timeOut || null, set_by: setBy || null, set_at: new Date().toISOString() }, { onConflict: 'pin,date' })
      if (error) throw new Error(error.message)
    },
    remove: async (pin, date) => {
      const { error } = await sb.from('day_overrides').delete().eq('pin', pin).eq('date', date)
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
