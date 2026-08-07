const $ = s => document.querySelector(s)
const api = async (url, opts) => {
  const r = await fetch(url, opts)
  const ct = r.headers.get('content-type') || ''
  if (!ct.includes('application/json')) return r
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'Request failed')
  return d
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b))
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + b.dataset.tab))
  if (b.dataset.tab === 'employees') loadEmployees()
  if (b.dataset.tab === 'devices') loadDevices()
})

async function loadStatus() {
  const s = await api('/api/status')
  $('#stats').innerHTML = `<div class="stat"><b>${s.devices}</b>devices</div><div class="stat"><b>${(s.punches || 0).toLocaleString()}</b>punches</div>`
}

// ── reports ────────────────────────────────────────────────
const COLS = {
  daily:   [['date', 'Date'], ['pin', 'PIN'], ['name', 'Name'], ['in', 'In'], ['lunchOut', 'Lunch Out'], ['lunchIn', 'Lunch In'], ['out', 'Out'], ['hours', 'Hours'], ['punches', 'Punches'], ['late', 'Late']],
  summary: [['pin', 'PIN'], ['name', 'Name'], ['days', 'Days'], ['hours', 'Total Hours'], ['late', 'Late Days']],
  punches: [['date', 'Date'], ['time', 'Time'], ['pin', 'PIN'], ['name', 'Name'], ['source', 'Source'], ['verify', 'Verify']],
}
const NUM = new Set(['hours', 'days', 'late', 'punches', 'verify'])
function qs() {
  const p = new URLSearchParams()
  for (const [k, id] of [['from', 'r-from'], ['to', 'r-to'], ['deviceId', 'r-device'], ['pin', 'r-pin']]) if ($('#' + id).value) p.set(k, $('#' + id).value)
  return p.toString()
}
async function runReport() {
  const kind = $('#r-kind').value
  const url = kind === 'punches' ? '/api/punches?' + qs() : `/api/report?kind=${kind}&` + qs()
  const rows = await api(url)
  const cols = COLS[kind]
  $('#repTable thead').innerHTML = '<tr>' + cols.map(c => `<th${NUM.has(c[0]) ? ' class="num"' : ''}>${c[1]}</th>`).join('') + '</tr>'
  const tb = $('#repTable tbody')
  if (!rows.length) { tb.innerHTML = `<tr><td colspan="${cols.length}"><div class="empty">No records for this filter.</div></td></tr>`; $('#repMeta').textContent = ''; return }
  tb.innerHTML = rows.map(r => {
    const row = { ...r }
    if (kind === 'punches') { row.date = (r.time || '').slice(0, 10); row.time = (r.time || '').slice(11, 19) }
    return '<tr>' + cols.map(c => {
      if (c[0] === 'late') return `<td class="num">${row[c[0]] ? '<span class="chip late">LATE</span>' : ''}</td>`
      return `<td class="${NUM.has(c[0]) ? 'num' : ''}">${esc(row[c[0]] ?? '')}</td>`
    }).join('') + '</tr>'
  }).join('')
  $('#repMeta').textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''}`
}
$('#runReport').addEventListener('click', runReport)
$('#expReport').addEventListener('click', () => { window.location = `/api/export?kind=${$('#r-kind').value}&` + qs() })

// ── employees ──────────────────────────────────────────────
async function loadEmployees() {
  const m = await api('/api/employees')
  const rows = Object.entries(m).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
  $('#empTable tbody').innerHTML = rows.length ? rows.map(([pin, name]) => `<tr><td class="mono">${esc(pin)}</td><td>${esc(name)}</td><td><button class="btn small danger" data-emp="${esc(pin)}">Remove</button></td></tr>`).join('')
    : '<tr><td colspan="3"><div class="empty">No names mapped yet.</div></td></tr>'
}
$('#saveEmp').addEventListener('click', async () => {
  const pin = $('#e-pin').value.trim(); if (!pin) return
  await api('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin, name: $('#e-name').value }) })
  $('#e-pin').value = ''; $('#e-name').value = ''; loadEmployees()
})
$('#empTable').addEventListener('click', async e => {
  const b = e.target.closest('[data-emp]'); if (!b) return
  await api('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: b.dataset.emp, name: '' }) })
  loadEmployees()
})

// ── devices ────────────────────────────────────────────────
async function loadDevices() {
  const list = await api('/api/devices')
  const sel = $('#r-device'); const cur = sel.value
  sel.innerHTML = '<option value="">All</option>' + list.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')
  sel.value = cur
  $('#devTable tbody').innerHTML = list.length ? list.map(d => `<tr>
    <td><b>${esc(d.name)}</b></td><td class="mono">${d.ip ? esc(d.ip) + ':' + d.port : '—'}</td>
    <td class="mono">${esc(d.serial || '—')}</td><td class="num">${(d.punches || 0).toLocaleString()}</td>
    <td><button class="btn small danger" data-del="${d.id}">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="5"><div class="empty">No devices yet.</div></td></tr>'
}
$('#showAdd').addEventListener('click', () => $('#addForm').classList.toggle('hidden'))
$('#cancelAdd').addEventListener('click', () => $('#addForm').classList.add('hidden'))
$('#saveDevice').addEventListener('click', async () => {
  $('#addErr').textContent = ''
  try {
    await api('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('#d-name').value, type: 'pull', ip: $('#d-ip').value, port: $('#d-port').value, serial: $('#d-serial').value }) })
    $('#addForm').classList.add('hidden'); for (const id of ['d-name', 'd-ip', 'd-serial']) $('#' + id).value = ''
    loadDevices(); loadStatus()
  } catch (e) { $('#addErr').textContent = e.message }
})
$('#devTable').addEventListener('click', async e => {
  const b = e.target.closest('[data-del]'); if (!b) return
  if (confirm('Remove this device? Collected punches are kept.')) { await api('/api/devices?id=' + b.dataset.del, { method: 'DELETE' }); loadDevices() }
})

// ── init ───────────────────────────────────────────────────
;(function () {
  const now = new Date(), first = new Date(now.getFullYear(), now.getMonth(), 1), iso = d => d.toLocaleDateString('en-CA')
  $('#r-from').value = iso(first); $('#r-to').value = iso(now)
})()
loadStatus(); loadDevices()
