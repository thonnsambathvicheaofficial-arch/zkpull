// ADMS / "PUSH" protocol receiver.
//
// Push-capable ZKTeco devices (set Comm -> Cloud Server / ADMS to this app's
// http://<this-pc-ip>:<port>) INITIATE outbound HTTP to /iclock/*. The device
// dials us, so there is no port-forward and it works over Wi-Fi/NAT. We only
// ever RECEIVE — we never queue a clear/delete command back to the device.
//
// Flow:
//   GET  /iclock/cdata?SN=..&options=all   -> handshake: we return device config
//   POST /iclock/cdata?SN=..&table=ATTLOG  -> attendance rows (tab-separated)
//   GET  /iclock/getrequest?SN=..          -> device asks for commands; we send none
//
// ATTLOG line:  PIN \t YYYY-MM-DD HH:MM:SS \t status \t verify \t [workcode ...]

const store = require('./store')

// Find the device for a serial, or auto-register it so pushing devices simply
// appear in the UI without manual setup.
function deviceForSerial(sn) {
  if (!sn) return null
  let d = store.devices.findBySerial(sn)
  if (!d) d = store.devices.add({ name: `ADMS ${sn}`, type: 'adms', ip: '', port: 4370, serial: String(sn) })
  return d
}

function parseAttlog(body) {
  const out = []
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const f = line.split('\t')
    if (f.length < 2) continue
    const pin = f[0].trim()
    const time = f[1].trim()                 // already "YYYY-MM-DD HH:MM:SS" local
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time)) continue
    out.push({ pin, time, status: Number(f[2] || 0) || 0, verify: Number(f[3] || 0) || 0 })
  }
  return out
}

// The registry block a device expects after its handshake GET.
function handshakeBody(sn) {
  return [
    `GET OPTION FROM: ${sn}`,
    'Stamp=9999', 'OpStamp=9999',
    'ErrorDelay=30', 'Delay=30',
    'TransTimes=00:00;14:05', 'TransInterval=1', 'TransFlag=1111000000',
    'TimeZone=7', 'Realtime=1', 'Encrypt=0',
  ].join('\r\n') + '\r\n'
}

// Mount all /iclock routes on an Express app. `log` is an optional callback for
// the live request feed shown in the UI.
function mount(app, log = () => {}) {
  // Device handshake / registry fetch.
  app.get('/iclock/cdata', (req, res) => {
    const sn = req.query.SN
    if (sn) { const d = deviceForSerial(sn); store.meta.setPull(d.id, { at: new Date().toISOString(), via: 'adms', ok: true, kind: 'handshake' }) }
    log({ method: 'GET', path: '/iclock/cdata', sn, note: 'handshake' })
    res.type('text/plain').send(handshakeBody(sn || ''))
  })

  // Attendance (and other tables) pushed by the device.
  app.post('/iclock/cdata', (req, res) => {
    const sn = req.query.SN
    const table = req.query.table || ''
    const d = deviceForSerial(sn)
    let inserted = 0, total = 0
    if (/ATTLOG/i.test(table) || !table) {
      const rows = parseAttlog(req.body)
      total = rows.length
      inserted = d ? store.punches.insertMany(d.id, sn, rows, 'adms') : 0
    }
    if (d) store.meta.setPull(d.id, { at: new Date().toISOString(), via: 'adms', ok: true, total, inserted, kind: table || 'ATTLOG' })
    log({ method: 'POST', path: '/iclock/cdata', sn, note: `${table || 'ATTLOG'} total=${total} new=${inserted}` })
    // Standard success reply.
    res.type('text/plain').send(`OK: ${total}`)
  })

  // Device polls for commands. We are read-only: never return a command.
  app.get('/iclock/getrequest', (req, res) => {
    log({ method: 'GET', path: '/iclock/getrequest', sn: req.query.SN, note: 'poll (no command)' })
    res.type('text/plain').send('OK')
  })

  // Command result callback + any other iclock chatter -> acknowledge only.
  app.all('/iclock/*', (req, res) => {
    log({ method: req.method, path: req.path, sn: req.query.SN, note: 'ack' })
    res.type('text/plain').send('OK')
  })
}

module.exports = { mount, parseAttlog }
