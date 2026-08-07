// ZK Report Puller — reports web app. Reads/writes Supabase; punches
// themselves are collected separately by cloud/agent, which runs on-site (on
// the same network as the ZKTeco devices) and pushes to Supabase. This app
// never talks to a device directly — it can't: on Vercel there's no route to
// a device's private LAN address. Deployable on Vercel or run locally.

const express = require('express')
const path = require('path')

const store = require('./lib/store')
const { dailyRows, summaryRows, timesheet } = require('./lib/attendance')
const { toXlsx } = require('./lib/excel')
const auth = require('./lib/auth')

const app = express()
const PORT = Number(process.env.PORT) || 8080

// ── body parsers ────────────────────────────────────────────
app.use('/api', express.json())

// ── login gate ──────────────────────────────────────────────
// Everything requires a valid session EXCEPT the login page + its assets and
// the login endpoint.
const OPEN = new Set(['/login', '/login.html', '/styles.css', '/logo.png', '/api/login', '/favicon.ico'])
app.use((req, res, next) => {
  if (OPEN.has(req.path)) return next()
  const user = auth.currentUser(req)
  if (user) { req.user = user; return next() }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' })
  return res.redirect('/login')
})

// Wrap async route handlers so a rejected promise reaches Express's error
// handler instead of crashing the process / hanging the request.
const h = fn => (req, res, next) => fn(req, res, next).catch(next)

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')))
app.post('/api/login', h(async (req, res) => {
  const { username, password } = req.body || {}
  const user = await auth.check(username, password)
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' })
  res.setHeader('Set-Cookie', `rp_session=${auth.sign(user.username, user.role)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${auth.MAXAGE}`)
  res.json({ ok: true, username: user.username })
}))
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'rp_session=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }) })
app.get('/api/me', (req, res) => res.json({
  username: req.user ? req.user.username : null,
  admin: req.user ? req.user.role === 'admin' : false,
}))

// ── user management (login accounts) — ADMIN ONLY ───────────
const requireAdmin = (req, res, next) =>
  (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'Admin access required.' })

app.get('/api/users', requireAdmin, h(async (req, res) => res.json(await auth.listUsers())))
app.post('/api/users', requireAdmin, h(async (req, res) => {
  const b = req.body || {}
  try { await auth.addUser(b.username, b.password, b.role); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
}))
app.patch('/api/users', requireAdmin, h(async (req, res) => {
  const b = req.body || {}
  try {
    await auth.updateUser(b.username, { newUsername: b.newUsername, password: b.password, role: b.role })
    // If admins rename or re-role THEMSELVES, their old session cookie no
    // longer matches (or has a stale role) — re-issue it so nothing breaks.
    const nn = (b.newUsername != null ? String(b.newUsername).trim() : '') || b.username
    if (req.user && req.user.username === b.username) {
      const fresh = (await auth.listUsers()).find(u => u.username === nn)
      if (fresh) res.setHeader('Set-Cookie', `rp_session=${auth.sign(fresh.username, fresh.role)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${auth.MAXAGE}`)
    }
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
}))
app.delete('/api/users', requireAdmin, h(async (req, res) => {
  try { await auth.deleteUser(req.query.username); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
}))

// ── helpers ─────────────────────────────────────────────────
// PINs belonging to a group ('office' | 'worker'), regardless of which device
// they punch on. Returns null when no group filter is requested (= everyone).
async function pinsInGroup(group) {
  if (!group) return null
  const emps = await store.employees.get()
  return new Set(Object.keys(emps).filter(pin => (emps[pin].group || null) === group))
}

// dailyRows() now walks every employee for every day in range (not just days
// that happen to have a punch), so a pin/group filter has to narrow the
// EMPLOYEE SET itself, not just the punches — otherwise everyone shows up
// regardless of the filter.
function filterEmployees(all, q, allowed) {
  let out = all
  if (q.pin) out = Object.fromEntries(Object.entries(out).filter(([pin]) => pin === String(q.pin)))
  if (allowed) out = Object.fromEntries(Object.entries(out).filter(([pin]) => allowed.has(pin)))
  return out
}

const pad = n => String(n).padStart(2, '0')
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const monthStartStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01` }
const currentMonthStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}` }

async function reportData(q) {
  const from = q.from || monthStartStr()
  const to = q.to || todayStr()
  let punches = await store.punches.query({ deviceId: q.deviceId, from, to, pin: q.pin })
  const allEmployees = await store.employees.get()
  const allowed = await pinsInGroup(q.group)
  if (allowed) punches = punches.filter(p => allowed.has(p.pin))
  const employees = filterEmployees(allEmployees, q, allowed)
  const settings = await store.settings.get()
  const overrides = await store.overrides.query({ from, to, pin: q.pin })
  const daily = dailyRows(punches, employees, settings, overrides, from, to)
  return { punches, daily, summary: summaryRows(daily), names: await store.employees.names() }
}

// ── API: status ─────────────────────────────────────────────
app.get('/api/status', h(async (req, res) => {
  const [devices, punches] = await Promise.all([store.devices.list(), store.punches.count()])
  res.json({ ok: true, devices: devices.length, punches })
}))

// ── API: devices ────────────────────────────────────────────
// Editable here even though this app never pulls them itself — cloud/agent
// (running on-site) reads this same table and picks up changes on its next cycle.
app.get('/api/devices', h(async (req, res) => {
  const [devices, counts] = await Promise.all([store.devices.list(), store.punches.countsByDevice()])
  res.json(devices.map(d => ({ ...d, punches: counts[d.id] || 0 })))
}))

app.post('/api/devices', h(async (req, res) => {
  const { name, type, ip, port, serial } = req.body || {}
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' })
  if (type === 'pull' && !ip) return res.status(400).json({ error: 'IP address is required for a TCP-pull device.' })
  const d = await store.devices.add({ name: name.trim(), type: type === 'pull' ? 'pull' : 'adms', ip: (ip || '').trim(), port: Number(port) || 4370, serial: (serial || '').trim() || null })
  res.json(d)
}))

app.patch('/api/devices/:id', h(async (req, res) => {
  const d = await store.devices.update(req.params.id, req.body || {})
  if (!d) return res.status(404).json({ error: 'Device not found.' })
  res.json(d)
}))

app.delete('/api/devices/:id', h(async (req, res) => { await store.devices.remove(req.params.id); res.json({ ok: true }) }))

// ── API: reports ────────────────────────────────────────────
app.get('/api/report/daily', h(async (req, res) => res.json((await reportData(req.query)).daily)))
app.get('/api/report/summary', h(async (req, res) => res.json((await reportData(req.query)).summary)))

// Monthly timesheet grid (uses ?month=YYYY-MM instead of from/to).
async function timesheetData(q) {
  const month = q.month || currentMonthStr()
  const [y, m] = month.split('-').map(Number)
  const from = `${month}-01`
  const to = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
  let punches = await store.punches.query({ deviceId: q.deviceId, from, to, pin: q.pin })
  const allEmployees = await store.employees.get()
  const allowed = await pinsInGroup(q.group)
  if (allowed) punches = punches.filter(p => allowed.has(p.pin))
  const employees = filterEmployees(allEmployees, q, allowed)
  const settings = await store.settings.get()
  const overrides = await store.overrides.query({ from, to, pin: q.pin })
  return timesheet(punches, employees, settings, overrides, month)
}
app.get('/api/report/timesheet', h(async (req, res) => res.json(await timesheetData(req.query))))

app.get('/api/punches', h(async (req, res) => {
  const emps = await store.employees.get()
  let rows = await store.punches.query(req.query)
  const allowed = await pinsInGroup(req.query.group)
  if (allowed) rows = rows.filter(p => allowed.has(p.pin))
  rows = rows.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0)
    .map(p => ({ ...p, name: (emps[p.pin] && emps[p.pin].name) || '', group: (emps[p.pin] && emps[p.pin].group) || null }))
  res.json(rows)
}))

// ── API: day overrides ──────────────────────────────────────
// See cloud/supabase/schema.sql day_overrides — the final source of truth for
// a (pin, date) when set. `note` is required, both by the DB and here.
const OVERRIDE_STATUSES = new Set(['present', 'day_off', 'leave', 'excused'])
app.get('/api/overrides', h(async (req, res) =>
  res.json(await store.overrides.query({ from: req.query.from, to: req.query.to, pin: req.query.pin }))))
app.post('/api/overrides', h(async (req, res) => {
  const b = req.body || {}
  const pin = b.pin != null ? String(b.pin).trim() : ''
  const date = (b.date || '').trim()
  const note = (b.note || '').trim()
  if (!pin) return res.status(400).json({ error: 'PIN is required.' })
  if (!date) return res.status(400).json({ error: 'Date is required.' })
  if (!OVERRIDE_STATUSES.has(b.status)) return res.status(400).json({ error: 'Invalid status.' })
  if (!note) return res.status(400).json({ error: 'A note is required — describe what happened.' })
  const timeIn = b.timeIn ? String(b.timeIn).trim() : null
  const timeOut = b.timeOut ? String(b.timeOut).trim() : null
  await store.overrides.set(pin, date, b.status, note, req.user.username, timeIn, timeOut)
  res.json({ ok: true })
}))
app.delete('/api/overrides', h(async (req, res) => {
  const pin = req.query.pin, date = req.query.date
  if (!pin || !date) return res.status(400).json({ error: 'PIN and date are required.' })
  await store.overrides.remove(String(pin), date)
  res.json({ ok: true })
}))

// ── API: exports (xlsx) ─────────────────────────────────────
function sendXlsx(res, filename, buf) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(buf)
}

const GROUP_LABEL = { office: 'Office Staff', worker: 'Worker' }
const glabel = g => GROUP_LABEL[g] || ''
const STATUS_LABEL = { present: 'Present', late: 'Late', absent: 'Absent', day_off: 'Day Off', leave: 'Leave', excused: 'Excused' }
const slabel = s => STATUS_LABEL[s] || s || ''

app.get('/api/export/timesheet', h(async (req, res) => {
  const ts = await timesheetData(req.query)
  const header = ['No', 'PIN', 'Name', 'Group', ...ts.days.map(d => String(d.d)), 'Total Hours', 'Days', 'Late', 'Early Leave']
  const rows = ts.rows.map((r, i) => [i + 1, r.pin, r.name, glabel(r.group), ...ts.days.map(d => (r.cells[d.d] ? r.cells[d.d].hours : '')), r.totalHours, r.daysPresent, r.lateDays, r.earlyDays])
  const cols = [5, 10, 22, 12, ...ts.days.map(() => 5), 11, 6, 6, 11]
  const suffix = req.query.group ? `_${req.query.group}` : ''
  sendXlsx(res, `Timesheet_${ts.month}${suffix}.xlsx`, toXlsx([{ name: 'Timesheet', header, rows, cols }]))
}))

app.get('/api/export/:kind', h(async (req, res) => {
  const { daily, summary, punches } = await reportData(req.query)
  const emps = await store.employees.get()
  const stamp = new Date().toISOString().slice(0, 10)
  const suffix = req.query.group ? `_${req.query.group}` : ''
  let sheet
  if (req.params.kind === 'summary') {
    sheet = { name: 'Summary', header: ['PIN', 'Name', 'Group', 'Days', 'Total Hours', 'Late Days', 'Early Leave Days', 'Absent', 'Day Off', 'Leave', 'Excused'],
      rows: summary.map(r => [r.pin, r.name, glabel(r.group), r.days, r.hours, r.late, r.early, r.absent, r.dayOff, r.leave, r.excused]),
      cols: [12, 24, 12, 8, 12, 10, 14, 9, 10, 8, 10] }
  } else if (req.params.kind === 'punches') {
    sheet = { name: 'Punches', header: ['Date', 'Time', 'PIN', 'Name', 'Group', 'Source', 'Verify'],
      rows: punches.sort((a, b) => a.time < b.time ? -1 : 1).map(p => [p.time.slice(0, 10), p.time.slice(11, 19), p.pin, (emps[p.pin] && emps[p.pin].name) || '', glabel(emps[p.pin] && emps[p.pin].group), p.source, p.verify]),
      cols: [12, 10, 12, 24, 12, 8, 8] }
  } else {
    sheet = { name: 'Daily', header: ['Date', 'PIN', 'Name', 'Group', 'Status', 'In', 'Out', 'Hours', 'Punches', 'Late', 'Early Leave', 'Note'],
      rows: daily.map(r => [r.date, r.pin, r.name, glabel(r.group), slabel(r.status), r.in, r.out, r.hours, r.punches, r.status === 'late' ? 'LATE' : '', r.earlyLeave ? 'EARLY' : '', r.note || '']),
      cols: [12, 12, 24, 12, 10, 8, 8, 8, 9, 7, 11, 30] }
  }
  sendXlsx(res, `Attendance_${req.params.kind}${suffix}_${stamp}.xlsx`, toXlsx([sheet]))
}))

// ── API: staff (employees) ──────────────────────────────────
app.get('/api/employees', h(async (req, res) => res.json(await store.employees.get())))
app.post('/api/employees', h(async (req, res) => {
  const b = req.body || {}
  if (b.pin == null || b.pin === '') return res.status(400).json({ error: 'PIN is required.' })
  const data = {}
  if ('name' in b) data.name = b.name
  if ('group' in b) data.group = b.group
  if ('timeIn' in b) data.timeIn = b.timeIn
  if ('timeOut' in b) data.timeOut = b.timeOut
  if ('offDays' in b && Array.isArray(b.offDays)) data.offDays = b.offDays.map(Number).filter(n => n >= 0 && n <= 6)
  if ('newPin' in b && b.newPin != null && String(b.newPin).trim() !== '') data.newPin = b.newPin
  try { await store.employees.set(String(b.pin), data); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
}))

// ── API: settings ───────────────────────────────────────────
app.get('/api/settings', h(async (req, res) => res.json(await store.settings.get())))
app.post('/api/settings', h(async (req, res) => res.json(await store.settings.set(req.body || {}))))

// ── error handler ───────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err)
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: err.message || 'Internal error' })
  res.status(500).send('Internal error')
})

// ── static UI ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')))

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Song Fa Water Tanks — Attendance Reports running`)
    console.log(`  Open:  http://localhost:${PORT}\n`)
  })
}

module.exports = app
