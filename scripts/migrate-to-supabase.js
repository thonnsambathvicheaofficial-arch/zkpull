const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const env = fs.readFileSync(path.join(root, '.env'), 'utf8')
const get = (label) => env.match(new RegExp(label + ':\\s*(\\S+)'))[1]
const url = get('Project URL')
const key = get('service role key')

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
}

async function upsert(table, rows, onConflict) {
  if (rows.length === 0) return
  const res = await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${table} upsert failed (${res.status}): ${text}`)
  }
}

async function migrateDevices() {
  const devices = JSON.parse(fs.readFileSync(path.join(root, 'data', 'devices.json'), 'utf8'))
  const rows = devices.map(d => ({
    id: d.id, name: d.name, type: d.type, ip: d.ip || null,
    port: d.port || 4370, serial: d.serial || null, created_at: d.createdAt,
  }))
  await upsert('devices', rows, 'id')
  console.log(`devices: migrated ${rows.length}`)
}

async function migrateEmployees() {
  const employees = JSON.parse(fs.readFileSync(path.join(root, 'data', 'employees.json'), 'utf8'))
  const rows = Object.entries(employees).map(([pin, e]) => ({
    pin, name: e.name || null, group: e.group || null,
    time_in: e.timeIn || null, time_out: e.timeOut || null,
  }))
  await upsert('employees', rows, 'pin')
  console.log(`employees: migrated ${rows.length}`)
}

async function migratePunches() {
  const punches = JSON.parse(fs.readFileSync(path.join(root, 'data', 'punches.json'), 'utf8'))
  const rows = punches.map(p => ({
    id: p.id, device_id: p.deviceId || null, serial: p.serial || null,
    pin: p.pin, ts: p.time, verify: p.verify ?? 0, status: p.status ?? 0,
    source: p.source || null,
  }))
  const BATCH = 2000
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    await upsert('punches', chunk, 'pin,ts')
    console.log(`punches: ${Math.min(i + BATCH, rows.length)}/${rows.length}`)
  }
}

async function main() {
  await migrateDevices()
  await migrateEmployees()
  await migratePunches()
  console.log('done')
}

main().catch(e => { console.error(e); process.exit(1) })
