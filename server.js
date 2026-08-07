// ZK Report Puller — a small standalone server that collects attendance from
// ZKTeco devices two ways:
//   • ADMS push   — devices POST to /iclock/* (set Cloud Server = this PC)
//   • TCP pull    — we dial the device on port 4370 and read its buffer
// …then builds attendance reports. READ-ONLY toward every device.

const express = require('express')
const path = require('path')
const os = require('os')

const store = require('./lib/store')
const adms = require('./lib/adms')
const { pullDevice, probeDevice } = require('./lib/zkpull')
const { dailyRows, summaryRows, timesheet } = require('./lib/attendance')
const { toXlsx } = require('./lib/excel')
const auth = require('./lib/auth')

const app = express()
const PORT = Number(process.env.PORT) || 8080

// ── live request feed (for the Activity panel) ──────────────
const feed = []
const logEvent = e => { feed.unshift({ ...e, at: new Date().toISOString() }); if (feed.length > 300) feed.pop() }

// ── body parsers ────────────────────────────────────────────
// /iclock bodies are raw text (tab-separated ATTLOG); everything else is JSON.
app.use('/iclock', express.text({ type: () => true, limit: '12mb' }))
app.use('/api', express.json())

// ── login gate ──────────────────────────────────────────────
// Everything requires a valid session EXCEPT: the login page + its assets, the
// login endpoint, and /iclock (devices pushing attendance can't hold a cookie).
const OPEN = new Set(['/login', '/login.html', '/styles.css', '/logo.png', '/api/login', '/favicon.ico'])
app.use((req, res, next) => {
  if (OPEN.has(req.path) || req.path.startsWith('/iclock')) return next()
  const user = auth.currentUser(req)
  if (user) { req.user = user; return next() }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' })
  return res.redirect('/login')
})

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')))
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!auth.check(username, password)) return res.status(401).json({ error: 'Invalid username or password.' })
  res.setHeader('Set-Cookie', `rp_session=${auth.sign(username)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${auth.MAXAGE}`)
  res.json({ ok: true, username })
})
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'rp_session=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }) })
app.get('/api/me', (req, res) => res.json({
  username: req.user ? req.user.username : null,
  admin: req.user ? auth.isAdmin(req.user.username) : false,
}))

// ── user management (login accounts) — ADMIN ONLY ───────────
const requireAdmin = (req, res, next) =>
  (req.user && auth.isAdmin(req.user.username)) ? next() : res.status(403).json({ error: 'Admin access required.' })

app.get('/api/users', requireAdmin, (req, res) => res.json(auth.listUsers()))
app.post('/api/users', requireAdmin, (req, res) => {
  const b = req.body || {}
  try { auth.addUser(b.username, b.password, b.role); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.patch('/api/users', requireAdmin, (req, res) => {
  const b = req.body || {}
  try {
    auth.updateUser(b.username, { newUsername: b.newUsername, password: b.password, role: b.role })
    // If admins rename THEMSELVES, their old session cookie no longer matches any
    // account (so they'd instantly lose admin rights). Re-issue the cookie under
    // the new name so the rename takes effect without a re-login.
    const nn = b.newUsername != null ? String(b.newUsername).trim() : ''
    if (nn && nn !== b.username && req.user && req.user.username === b.username) {
      res.setHeader('Set-Cookie', `rp_session=${auth.sign(nn)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${auth.MAXAGE}`)
    }
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.delete('/api/users', requireAdmin, (req, res) => {
  try { auth.deleteUser(req.query.username); res.json({ ok: true }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

// ── ADMS receiver (must be before static) ───────────────────
adms.mount(app, logEvent)

// ── helpers ─────────────────────────────────────────────────
const localIPs = () => Object.values(os.networkInterfaces()).flat()
  .filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address)

// PINs belonging to a group ('office' | 'worker'), regardless of which device
// they punch on. Returns null when no group filter is requested (= everyone).
function pinsInGroup(group) {
  if (!group) return null
  const emps = store.employees.get()
  return new Set(Object.keys(emps).filter(pin => (emps[pin].group || null) === group))
}

function reportData(q) {
  let punches = store.punches.query({ deviceId: q.deviceId, from: q.from, to: q.to, pin: q.pin })
  const allowed = pinsInGroup(q.group)
  if (allowed) punches = punches.filter(p => allowed.has(p.pin))
  const daily = dailyRows(punches, store.employees.get(), store.settings.get())
  return { punches, daily, summary: summaryRows(daily), names: store.employees.names() }
}

// ── API: status ─────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    devices: store.devices.list().length,
    punches: store.punches.count(),
    admsEndpoints: localIPs().map(ip => `http://${ip}:${PORT}`),
    port: PORT,
  })
})

// ── API: devices ────────────────────────────────────────────
app.get('/api/devices', (req, res) => {
  const meta = store.meta.get()
  const counts = {}
  for (const p of store.punches.all()) counts[p.deviceId] = (counts[p.deviceId] || 0) + 1
  res.json(store.devices.list().map(d => ({ ...d, punches: counts[d.id] || 0, last: meta[d.id] || null })))
})

app.post('/api/devices', (req, res) => {
  const { name, type, ip, port, serial } = req.body || {}
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' })
  if (type === 'pull' && !ip) return res.status(400).json({ error: 'IP address is required for a TCP-pull device.' })
  const d = store.devices.add({ name: name.trim(), type: type === 'pull' ? 'pull' : 'adms', ip: (ip || '').trim(), port: Number(port) || 4370, serial: (serial || '').trim() || null })
  res.json(d)
})

app.patch('/api/devices/:id', (req, res) => {
  const d = store.devices.update(req.params.id, req.body || {})
  if (!d) return res.status(404).json({ error: 'Device not found.' })
  res.json(d)
})

app.delete('/api/devices/:id', (req, res) => { store.devices.remove(req.params.id); res.json({ ok: true }) })

// ── API: pull / probe (TCP) ─────────────────────────────────
async function doPull(d) {
  if (!d.ip) return { device: d.name, ok: false, error: 'No IP set (ADMS device — data arrives by push).' }
  const r = await pullDevice(d)
  let inserted = 0
  if (r.ok) inserted = store.punches.insertMany(d.id, d.serial, r.punches, 'pull')
  store.meta.setPull(d.id, { at: new Date().toISOString(), via: 'pull', ok: r.ok, total: r.total || 0, inserted, error: r.error || null })
  logEvent({ method: 'PULL', path: d.name, note: r.ok ? `total=${r.total} new=${inserted}` : `error: ${r.error}` })
  return { device: d.name, ok: r.ok, total: r.total || 0, inserted, error: r.error || null }
}

app.post('/api/pull', async (req, res) => {
  const id = req.query.deviceId
  if (id) {
    const d = store.devices.get(id)
    if (!d) return res.status(404).json({ error: 'Device not found.' })
    return res.json(await doPull(d))
  }
  // pull all TCP devices (those with an IP)
  const results = []
  for (const d of store.devices.list()) if (d.ip) results.push(await doPull(d))
  res.json({ ok: true, results })
})

app.post('/api/probe', async (req, res) => {
  const d = store.devices.get(req.query.deviceId)
  if (!d) return res.status(404).json({ error: 'Device not found.' })
  if (!d.ip) return res.json({ ok: false, error: 'No IP (ADMS device).' })
  res.json(await probeDevice(d))
})

// ── API: reports ────────────────────────────────────────────
app.get('/api/report/daily',   (req, res) => res.json(reportData(req.query).daily))
app.get('/api/report/summary', (req, res) => res.json(reportData(req.query).summary))

// Monthly timesheet grid (uses ?month=YYYY-MM instead of from/to).
function timesheetData(q) {
  const month = q.month || new Date().toISOString().slice(0, 7)
  const [y, m] = month.split('-').map(Number)
  const from = `${month}-01`
  const to = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
  let punches = store.punches.query({ deviceId: q.deviceId, from, to, pin: q.pin })
  const allowed = pinsInGroup(q.group)
  if (allowed) punches = punches.filter(p => allowed.has(p.pin))
  return timesheet(punches, store.employees.get(), store.settings.get(), month)
}
app.get('/api/report/timesheet', (req, res) => res.json(timesheetData(req.query)))
app.get('/api/punches', (req, res) => {
  const emps = store.employees.get()
  let rows = store.punches.query(req.query)
  const allowed = pinsInGroup(req.query.group)
  if (allowed) rows = rows.filter(p => allowed.has(p.pin))
  rows = rows.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0)
    .map(p => ({ ...p, name: (emps[p.pin] && emps[p.pin].name) || '', group: (emps[p.pin] && emps[p.pin].group) || null }))
  res.json(rows)
})

// ── API: exports (xlsx) ─────────────────────────────────────
function sendXlsx(res, filename, buf) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(buf)
}

const GROUP_LABEL = { office: 'Office Staff', worker: 'Worker' }
const glabel = g => GROUP_LABEL[g] || ''

app.get('/api/export/timesheet', (req, res) => {
  const ts = timesheetData(req.query)
  const header = ['No', 'PIN', 'Name', 'Group', ...ts.days.map(d => String(d.d)), 'Total Hours', 'Days', 'Late', 'Early Leave']
  const rows = ts.rows.map((r, i) => [i + 1, r.pin, r.name, glabel(r.group), ...ts.days.map(d => (r.cells[d.d] ? r.cells[d.d].hours : '')), r.totalHours, r.daysPresent, r.lateDays, r.earlyDays])
  const cols = [5, 10, 22, 12, ...ts.days.map(() => 5), 11, 6, 6, 11]
  const suffix = req.query.group ? `_${req.query.group}` : ''
  sendXlsx(res, `Timesheet_${ts.month}${suffix}.xlsx`, toXlsx([{ name: 'Timesheet', header, rows, cols }]))
})

app.get('/api/export/:kind', (req, res) => {
  const { daily, summary, punches } = reportData(req.query)
  const emps = store.employees.get()
  const stamp = new Date().toISOString().slice(0, 10)
  const suffix = req.query.group ? `_${req.query.group}` : ''
  let sheet
  if (req.params.kind === 'summary') {
    sheet = { name: 'Summary', header: ['PIN', 'Name', 'Group', 'Days', 'Total Hours', 'Late Days', 'Early Leave Days'],
      rows: summary.map(r => [r.pin, r.name, glabel(r.group), r.days, r.hours, r.late, r.early]), cols: [12, 24, 12, 8, 12, 10, 14] }
  } else if (req.params.kind === 'punches') {
    sheet = { name: 'Punches', header: ['Date', 'Time', 'PIN', 'Name', 'Group', 'Source', 'Verify'],
      rows: punches.sort((a, b) => a.time < b.time ? -1 : 1).map(p => [p.time.slice(0, 10), p.time.slice(11, 19), p.pin, (emps[p.pin] && emps[p.pin].name) || '', glabel(emps[p.pin] && emps[p.pin].group), p.source, p.verify]),
      cols: [12, 10, 12, 24, 12, 8, 8] }
  } else {
    sheet = { name: 'Daily', header: ['Date', 'PIN', 'Name', 'Group', 'In', 'Out', 'Hours', 'Punches', 'Late', 'Early Leave'],
      rows: daily.map(r => [r.date, r.pin, r.name, glabel(r.group), r.in, r.out, r.hours, r.punches, r.late ? 'LATE' : '', r.earlyLeave ? 'EARLY' : '']),
      cols: [12, 12, 24, 12, 8, 8, 8, 9, 7, 11] }
  }
  sendXlsx(res, `Attendance_${req.params.kind}${suffix}_${stamp}.xlsx`, toXlsx([sheet]))
})

// ── API: staff (employees) ──────────────────────────────────
app.get('/api/employees', (req, res) => res.json(store.employees.get()))
app.post('/api/employees', (req, res) => {
  const b = req.body || {}
  if (b.pin == null || b.pin === '') return res.status(400).json({ error: 'PIN is required.' })
  const data = {}
  if ('name' in b) data.name = b.name
  if ('group' in b) data.group = b.group
  if ('timeIn' in b) data.timeIn = b.timeIn
  if ('timeOut' in b) data.timeOut = b.timeOut
  store.employees.set(String(b.pin), data)
  res.json({ ok: true })
})

// ── API: settings ───────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(store.settings.get()))
app.post('/api/settings', (req, res) => { const s = store.settings.set(req.body || {}); scheduleAutoPull(); res.json(s) })

// ── API: activity feed ──────────────────────────────────────
app.get('/api/logs', (req, res) => res.json(feed.slice(0, 100)))

// ── static UI ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')))

// ── optional auto-pull ──────────────────────────────────────
let autoTimer = null
function scheduleAutoPull() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
  const mins = Number(store.settings.get().autoPullMinutes) || 0
  if (mins > 0) autoTimer = setInterval(async () => {
    for (const d of store.devices.list()) if (d.ip) await doPull(d)
  }, mins * 60 * 1000)
}

app.listen(PORT, () => {
  scheduleAutoPull()
  console.log(`\n  Song Fa Water Tanks — Attendance System running`)
  console.log(`  Open:  http://localhost:${PORT}`)
  for (const ip of localIPs()) console.log(`  ADMS:  http://${ip}:${PORT}   (set this as the device Cloud Server)`)
  console.log('')
})
