const $ = s => document.querySelector(s)
const api = async (url, opts) => {
  const r = await fetch(url, opts)
  if (r.status === 401) { location.href = '/login'; throw new Error('Not authenticated') }
  const ct = r.headers.get('content-type') || ''
  if (!ct.includes('application/json')) return r
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'Request failed')
  return d
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// ── tabs ────────────────────────────────────────────────────
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b))
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + b.dataset.tab))
  if (b.dataset.tab === 'live') loadLive()
  if (b.dataset.tab === 'devices') loadDevices()
  if (b.dataset.tab === 'timesheet') runTimesheet()
  if (b.dataset.tab === 'employees') loadEmployees()
  if (b.dataset.tab === 'users') loadUsers()
})

// Group badge — used in Staff, Reports, and Timesheet rows.
function groupChip(g) {
  if (g === 'office') return '<span class="chip group-office">Office Staff</span>'
  if (g === 'worker') return '<span class="chip group-worker">Worker</span>'
  return '<span class="mono">—</span>'
}

// Day status — shared between the Reports/Daily table and the Timesheet grid.
const STATUS_LABEL = { present: 'Present', late: 'Late', absent: 'Absent', day_off: 'Day Off', leave: 'Leave', excused: 'Excused' }
const STATUS_CLASS = { present: 'present', late: 'late', absent: 'absent-flag', day_off: 'day-off', leave: 'leave', excused: 'excused' }
const DOW_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function offDaysHtml(selected) {
  const sel = new Set(selected && selected.length ? selected : [0, 6])
  return DOW_LETTERS.map((l, i) => `<button type="button" class="${sel.has(i) ? 'on' : ''}" data-dow="${i}">${l}</button>`).join('')
}
function readOffDays(container) { return [...container.querySelectorAll('button.on')].map(b => Number(b.dataset.dow)) }
document.addEventListener('click', e => { const b = e.target.closest('.offdays button'); if (b) b.classList.toggle('on') })

// ── status ──────────────────────────────────────────────────
async function loadStatus() {
  const s = await api('/api/status')
  $('#stats').innerHTML =
    `<div class="stat"><b>${s.devices}</b>devices</div>` +
    `<div class="stat"><b>${s.punches.toLocaleString()}</b>punches</div>`
}

// ── live activity ───────────────────────────────────────────
async function loadLive() {
  const pad = n => String(n).padStart(2, '0')
  const d = new Date()
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const punches = await api(`/api/punches?from=${today}&to=${today}`)
  
  const byPin = {}
  for (const p of punches) {
    if (!byPin[p.pin]) {
      byPin[p.pin] = p
    } else {
      if (p.time < byPin[p.pin].time) byPin[p.pin] = p
    }
  }
  
  const rows = Object.values(byPin)
  rows.sort((a, b) => a.time > b.time ? -1 : a.time < b.time ? 1 : 0)
  
  const tbody = $('#liveTable tbody')
  if (!rows.length) {
    $('#liveTable').style.display = 'none'
    $('#liveEmpty').style.display = 'block'
    return
  }
  
  $('#liveTable').style.display = 'table'
  $('#liveEmpty').style.display = 'none'
  
  const initials = name => (name || '?').split(' ').map(s => s[0]).join('').substring(0, 2).toUpperCase()
  
  const formatTime = iso => {
    const t = new Date(iso)
    let h = t.getHours(), m = t.getMinutes()
    const ampm = h >= 12 ? 'PM' : 'AM'
    h = h % 12; if (h === 0) h = 12
    return `${pad(h)}:${pad(m)} ${ampm}`
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>
        <div class="live-staff-cell">
          <div class="live-avatar">${esc(initials(r.name))}</div>
          <div class="live-staff-details">
            <span class="live-name">${esc(r.name || 'Unknown')}</span>
            <span class="live-meta">
              <span>${esc(r.pin)}</span>
              ${r.group ? `<span>&middot;</span><span style="display:flex;align-items:center;gap:0.25rem;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>${esc(r.group)}</span>` : ''}
            </span>
          </div>
        </div>
      </td>
      <td class="live-in-time">
        ${formatTime(r.time)}
      </td>
    </tr>
  `).join('')
}


// ── devices ─────────────────────────────────────────────────
// Relative age string ("3m ago", "2h ago", "5d ago") for a heartbeat timestamp.
function agoText(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return min + 'm ago'
  const hr = Math.floor(min / 60)
  if (hr < 24) return hr + 'h ago'
  return Math.floor(hr / 24) + 'd ago'
}
// Sync status for one 'pull' device — the background puller writes lastPullAt/Ok/Error
// after every attempt, so this is a direct signal it reached Supabase.
const STALE_MIN = 30 // no successful pull in this long -> cron/puller likely failing
function syncCellHtml(d) {
  if (d.type !== 'pull') return '<span class="mono">—</span>'
  if (!d.lastPullAt) return '<span class="chip sync-never">Never synced</span>'
  const ageMin = (Date.now() - new Date(d.lastPullAt).getTime()) / 60000
  const ago = agoText(d.lastPullAt)
  if (d.lastPullOk === false) return `<span class="chip sync-error" title="${esc(d.lastPullError || '')}">Sync failed · ${ago}</span>`
  if (ageMin > STALE_MIN) return `<span class="chip sync-stale">Stale · ${ago}</span>`
  return `<span class="chip sync-ok">Synced ${ago}</span>`
}
function renderAgentBanner(list) {
  const el = $('#agentBanner')
  const pulled = list.filter(d => d.type === 'pull')
  if (!pulled.length) { el.innerHTML = ''; return }
  const latest = pulled.reduce((max, d) => (d.lastPullAt && (!max || d.lastPullAt > max)) ? d.lastPullAt : max, null)
  const anyOk = pulled.some(d => d.lastPullOk === true && (Date.now() - new Date(d.lastPullAt).getTime()) / 60000 <= STALE_MIN)
  if (!latest) {
    el.innerHTML = '<div class="banner banner-warn">Devices have not been synced yet. Configure a Public Host to enable WAN pull.</div>'
  } else if (!anyOk) {
    el.innerHTML = `<div class="banner banner-warn">Background sync hasn't succeeded in the last ${STALE_MIN} min (last activity ${esc(agoText(latest))}).</div>`
  } else {
    el.innerHTML = `<div class="banner banner-ok">Background sync active — last synced ${esc(agoText(latest))}.</div>`
  }
}
async function loadDevices() {
  const list = await api('/api/devices')
  renderAgentBanner(list)
  const tb = $('#devTable tbody')
  const opts = '<option value="">All</option>' + list.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')
  for (const id of ['#r-device', '#ts-device']) {
    const sel = $(id); if (!sel) continue
    const cur = sel.value; sel.innerHTML = opts; sel.value = cur
  }
  if (!list.length) { tb.innerHTML = '<tr><td colspan="7"><div class="empty">No devices yet. Add one and configure its public host for background syncing.</div></td></tr>'; return }
  tb.innerHTML = list.map(d => {
    const canPull = d.type === 'pull' && d.publicHost
    return `<tr data-device-id="${d.id}">
      <td><b>${esc(d.name)}</b></td>
      <td><span class="chip ${d.type === 'pull' ? 'pull' : d.type === 'adms' ? 'adms' : 'import'}">${d.type === 'pull' ? 'TCP Pull' : d.type === 'adms' ? 'ADMS' : 'Imported'}</span></td>
      <td class="mono">${d.ip ? esc(d.ip) + ':' + d.port : '—'}</td>
      <td class="mono">${esc(d.serial || '—')}</td>
      <td class="num">${d.punches.toLocaleString()}</td>
      <td class="sync-cell">${syncCellHtml(d)}</td>
      <td class="actions">
        ${canPull ? `<button class="btn small pull-btn" data-pull="${d.id}" title="Pull now from ${esc(d.publicHost)}:${d.publicPort || 4370}">⬇ Pull</button>` : ''}
        <button class="btn small danger" data-del="${d.id}">Delete</button>
      </td></tr>`
  }).join('')
}

$('#devTable').addEventListener('click', async e => {
  const del = e.target.closest('[data-del]')
  if (del) {
    if (confirm('Remove this device? Punches already collected are kept.')) {
      await api('/api/devices/' + del.dataset.del, { method: 'DELETE' })
      loadDevices()
    }
    return
  }

  const pullBtn = e.target.closest('[data-pull]')
  if (pullBtn) {
    const id = pullBtn.dataset.pull
    const row = pullBtn.closest('tr')
    const syncCell = row && row.querySelector('.sync-cell')

    // Lock button + show spinner
    pullBtn.disabled = true
    pullBtn.innerHTML = '<span class="pull-spinner"></span> Pulling…'
    if (syncCell) syncCell.innerHTML = '<span class="chip sync-pulling">Pulling…</span>'

    try {
      const result = await api(`/api/devices/${id}/pull`, { method: 'POST' })
      if (result.skippedRead) {
        if (syncCell) syncCell.innerHTML = `<span class="chip sync-ok" title="No new records — device count unchanged (${result.totalOnDevice ?? '?'} total)">No change · just now</span>`
      } else {
        const pushed = result.pushed ?? 0
        const total = result.totalOnDevice ?? '?'
        const msg = pushed > 0 ? `+${pushed} new · just now` : `Up to date · just now`
        if (syncCell) syncCell.innerHTML = `<span class="chip sync-ok" title="Read ${total} on device, pushed ${pushed} new">${msg}</span>`
        if (pushed > 0) loadStatus()   // refresh punch counter in header
      }
      // Reload full list after a short delay so heartbeat columns update
      setTimeout(loadDevices, 800)
    } catch (err) {
      if (syncCell) syncCell.innerHTML = `<span class="chip sync-error" title="${esc(err.message)}">Failed · ${esc(err.message.slice(0, 40))}</span>`
      pullBtn.disabled = false
      pullBtn.innerHTML = '⬇ Pull'
    }
  }
})

$('#showAdd').addEventListener('click', () => $('#addForm').classList.toggle('hidden'))
$('#cancelAdd').addEventListener('click', () => $('#addForm').classList.add('hidden'))
$('#saveDevice').addEventListener('click', async () => {
  $('#addErr').textContent = ''
  try {
    await api('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('#d-name').value, type: $('#d-type').value, ip: $('#d-ip').value, port: $('#d-port').value, serial: $('#d-serial').value }) })
    $('#addForm').classList.add('hidden')
    for (const id of ['d-name', 'd-ip', 'd-serial']) $('#' + id).value = ''
    loadDevices(); loadStatus()
  } catch (e) { $('#addErr').textContent = e.message }
})

// ── reports ─────────────────────────────────────────────────
const COLS = {
  daily:   [['date', 'Date'], ['pin', 'PIN'], ['name', 'Name'], ['group', 'Group'], ['status', 'Status'], ['in', 'In'], ['out', 'Out'], ['hours', 'Hours'], ['punches', 'Punches'], ['earlyLeave', 'Early Leave'], ['note', 'Note']],
  summary: [['pin', 'PIN'], ['name', 'Name'], ['group', 'Group'], ['days', 'Days'], ['hours', 'Total Hours'], ['late', 'Late'], ['early', 'Early Leave'], ['absent', 'Absent'], ['dayOff', 'Day Off'], ['leave', 'Leave'], ['excused', 'Excused']],
  punches: [['date', 'Date'], ['time', 'Time'], ['pin', 'PIN'], ['name', 'Name'], ['group', 'Group'], ['source', 'Source'], ['verify', 'Verify']],
}
function qs() {
  const p = new URLSearchParams()
  for (const [k, id] of [['from', 'r-from'], ['to', 'r-to'], ['deviceId', 'r-device'], ['group', 'r-group'], ['pin', 'r-pin']]) if ($('#' + id).value) p.set(k, $('#' + id).value)
  return p.toString()
}
async function runReport() {
  const kind = $('#r-kind').value
  const url = kind === 'punches' ? '/api/punches?' + qs() : `/api/report/${kind}?` + qs()
  const rows = await api(url)
  const cols = COLS[kind]
  const NUM_COLS = ['hours', 'days', 'late', 'early', 'punches', 'verify', 'absent', 'dayOff', 'leave', 'excused']
  $('#repTable thead').innerHTML = '<tr>' + cols.map(c => `<th${NUM_COLS.includes(c[0]) ? ' class="num"' : ''}>${c[1]}</th>`).join('') + '</tr>'
  const tb = $('#repTable tbody')
  if (!rows.length) { tb.innerHTML = `<tr><td colspan="${cols.length}"><div class="empty">No records for this filter.</div></td></tr>`; $('#repMeta').textContent = ''; return }
  tb.innerHTML = rows.map(r => {
    const row = { ...r }
    if (kind === 'punches') { row.date = r.time.slice(0, 10); row.time = r.time.slice(11, 19) }
    return '<tr>' + cols.map(c => {
      let v = row[c[0]]
      if (c[0] === 'earlyLeave') return `<td class="num">${v ? '<span class="chip early">EARLY</span>' : ''}</td>`
      if (c[0] === 'group') return `<td>${groupChip(v)}</td>`
      if (c[0] === 'status') return `<td><span class="chip status-${esc(v)}">${esc(STATUS_LABEL[v] || v || '')}</span></td>`
      if (c[0] === 'note') return `<td class="note-text">${esc(v || '')}</td>`
      const num = NUM_COLS.includes(c[0])
      return `<td class="${num ? 'num' : ''}">${esc(v ?? '')}</td>`
    }).join('') + '</tr>'
  }).join('')
  $('#repMeta').textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''}`
}
$('#runReport').addEventListener('click', runReport)
$('#r-group').addEventListener('change', runReport)
$('#expReport').addEventListener('click', () => { window.location = `/api/export/${$('#r-kind').value}?` + qs() })

// ── timesheet (monthly grid) ───────────────────────────────
let tsData = null
let tsSort = { key: 'name', dir: 1 }   // dir: 1 = asc, -1 = desc
const TS_SORT_COLS = { name: 'Employee', totalHours: 'Hrs', daysPresent: 'Days', lateDays: 'Late', earlyDays: 'Early' }
const TS_TOT_CLASS = { totalHours: 'tot-hrs', daysPresent: 'tot-days', lateDays: 'tot-late', earlyDays: 'tot-early' }

function tsParams() {
  const p = new URLSearchParams()
  if ($('#ts-month').value) p.set('month', $('#ts-month').value)
  if ($('#ts-device').value) p.set('deviceId', $('#ts-device').value)
  if ($('#ts-group').value) p.set('group', $('#ts-group').value)
  return p
}
async function runTimesheet() {
  try { tsData = await api('/api/report/timesheet?' + tsParams().toString()); renderTimesheet() } catch (e) { /* ignore */ }
}

function tsSortRows(rows) {
  const val = r => tsSort.key === 'name' ? (r.name || r.pin).toLowerCase() : (r[tsSort.key] || 0)
  return [...rows].sort((a, b) => {
    const va = val(a), vb = val(b)
    if (va < vb) return -1 * tsSort.dir
    if (va > vb) return 1 * tsSort.dir
    return 0
  })
}

function renderTimesheet() {
  if (!tsData) return
  const q = ($('#ts-search').value || '').toLowerCase()
  const filtered = tsData.rows.filter(r => !q || (r.name || '').toLowerCase().includes(q) || r.pin.toLowerCase().includes(q))
  const rows = tsSortRows(filtered)
  const days = tsData.days
  const todayStr = new Date().toLocaleDateString('en-CA')
  const isCurrentMonth = tsData.month === todayStr.slice(0, 7)
  const todayDay = isCurrentMonth ? Number(todayStr.slice(8, 10)) : null

  // ── stat cards (computed from the currently filtered set) ──
  const totHours = filtered.reduce((a, r) => a + r.totalHours, 0)
  const totDays = filtered.reduce((a, r) => a + r.daysPresent, 0)
  const totLate = filtered.reduce((a, r) => a + (r.lateDays || 0), 0)
  const totEarly = filtered.reduce((a, r) => a + (r.earlyDays || 0), 0)
  // Every day now has a cell (server-side, not a client-side "no cell" guess) —
  // count actual 'absent' status, not the old !cell + past-weekday heuristic.
  let absentCount = 0
  for (const r of filtered) for (const d of days) { if (r.cells[d.d] && r.cells[d.d].status === 'absent') absentCount++ }
  const avgHours = totDays ? Math.round((totHours / totDays) * 10) / 10 : 0
  $('#tsStats').innerHTML = [
    ['Staff shown', filtered.length, ''],
    ['Total hours', totHours.toLocaleString(undefined, { maximumFractionDigits: 1 }), ''],
    ['Avg hrs / day', avgHours, ''],
    ['Late instances', totLate, 'warn'],
    ['Early-leave instances', totEarly, 'early'],
    ['Unexcused absences', absentCount, 'bad'],
  ].map(([label, val, cls]) => `<div class="ts-stat ${cls}"><b>${val}</b><span>${label}</span></div>`).join('')

  // ── header ──
  const arrow = key => tsSort.key === key ? `<span class="arrow">${tsSort.dir === 1 ? '▲' : '▼'}</span>` : ''
  const sortTh = (key, label, extraCls) => `<th class="sortable ${tsSort.key === key ? 'sort-active' : ''} ${extraCls || ''}" data-sort="${key}">${label}${arrow(key)}</th>`
  $('#tsTable thead').innerHTML = '<tr>' +
    sortTh('name', 'Employee', 'name') +
    days.map(d => `<th class="${d.weekend ? 'wend' : ''}${d.d === todayDay ? ' today' : ''}">${d.d}<span class="wd">${d.wd[0]}</span></th>`).join('') +
    sortTh('totalHours', 'Hrs', 'tot tot-hrs') + sortTh('daysPresent', 'Days', 'tot tot-days') +
    sortTh('lateDays', 'Late', 'tot tot-late') + sortTh('earlyDays', 'Early', 'tot tot-early') +
    '</tr>'

  // ── body ──
  const tb = $('#tsTable tbody')
  if (!rows.length) { tb.innerHTML = `<tr><td class="name">—</td><td colspan="${days.length + 4}"><div class="empty">No attendance for this month.</div></td></tr>`; $('#tsTable tfoot').innerHTML = ''; return }
  const PRESENT_ISH = new Set(['present', 'late', 'excused'])
  tb.innerHTML = rows.map(r => '<tr>' +
    `<td class="name"><b>${esc(r.name || r.pin)}</b> ${groupChip(r.group)}${r.name ? ` <span class="mono">${esc(r.pin)}</span>` : ''}</td>` +
    days.map(d => {
      const dateStr = `${tsData.month}-${String(d.d).padStart(2, '0')}`
      const c = r.cells[d.d]
      const todayCls = d.d === todayDay ? ' today-col' : ''
      const attrs = `data-pin="${esc(r.pin)}" data-date="${dateStr}"`
      if (!c) return `<td class="day-cell${d.weekend ? ' wend' : ''}${todayCls}" ${attrs}></td>`   // defensive; every day should have a cell now
      const statusCls = STATUS_CLASS[c.status] || ''
      const cls = ['day-cell', d.weekend ? 'wend' : '', statusCls, c.earlyLeave ? 'early' : '', c.overridden ? 'has-note' : '', todayCls].filter(Boolean).join(' ')
      const titleBits = [STATUS_LABEL[c.status] || c.status]
      if (c.in) titleBits.push(`${c.in}-${c.out || '?'}`)
      if (c.earlyLeave) titleBits.push('left early')
      if (c.note) titleBits.push('Note: ' + c.note)
      const text = (c.status === 'present' || c.status === 'late' || (c.status === 'excused' && c.hours)) ? (c.hours || '') : ''
      return `<td class="${cls}" ${attrs} title="${esc(titleBits.join(' · '))}">${text}</td>`
    }).join('') +
    `<td class="tot tot-hrs">${r.totalHours}</td><td class="tot tot-days">${r.daysPresent}</td><td class="tot tot-late">${r.lateDays || ''}</td><td class="tot tot-early">${r.earlyDays || ''}</td></tr>`
  ).join('')

  // ── footer: daily headcount-present + grand totals ──
  const headcount = d => rows.reduce((a, r) => a + (r.cells[d.d] && PRESENT_ISH.has(r.cells[d.d].status) ? 1 : 0), 0)
  $('#tsTable tfoot').innerHTML = '<tr>' +
    `<td class="name">Present / day</td>` +
    days.map(d => `<td class="${d.weekend ? 'wend' : ''}">${d.weekend ? '' : (headcount(d) || '')}</td>`).join('') +
    `<td class="tot tot-hrs">${Math.round(totHours * 10) / 10}</td><td class="tot tot-days">${totDays}</td><td class="tot tot-late">${totLate || ''}</td><td class="tot tot-early">${totEarly || ''}</td></tr>`
}

$('#tsTable').addEventListener('click', e => {
  const th = e.target.closest('th.sortable')
  if (th) {
    const key = th.dataset.sort
    if (tsSort.key === key) tsSort.dir *= -1
    else tsSort = { key, dir: key === 'name' ? 1 : -1 }   // numeric columns default to "highest first"
    renderTimesheet()
    return
  }
  const cell = e.target.closest('td.day-cell')
  if (cell) openOverrideModal(cell.dataset.pin, cell.dataset.date)
})

// ── day-override editor (click a Timesheet cell) ────────────
function openOverrideModal(pin, date) {
  const day = Number(date.slice(8, 10))
  const row = tsData && tsData.rows.find(r => r.pin === pin)
  const c = row && row.cells[day]
  const existing = c && c.overridden ? { status: c.status, note: c.note } : null
  const name = row ? (row.name || pin) : pin
  // Prefill from whatever's already showing in the cell — real scanned times
  // if there are any, or a previously-entered manual correction. Either way
  // this is what dailyRows() would show for this day right now.
  const prefIn = c ? (c.in || '') : ''
  const prefOut = c ? (c.out || '') : ''

  const opt = (val, label) => `<option value="${val}"${(existing ? existing.status : 'excused') === val ? ' selected' : ''}>${label}</option>`
  $('#ovModal').innerHTML = `
    <div class="modal">
      <h3>${esc(name)}</h3>
      <p class="sub">${esc(date)}${existing ? ' · currently overridden' : ' · no override set'}</p>
      <div class="field">
        <label>Status</label>
        <select id="ov-status">
          ${opt('present', 'Present (correct a bad/missing scan)')}
          ${opt('day_off', 'Day Off')}
          ${opt('leave', 'Leave')}
          ${opt('excused', "Excused (pre-notified, couldn't scan)")}
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label>Time In<input type="time" id="ov-timeIn" value="${esc(prefIn)}" /></label>
        <label>Time Out<input type="time" id="ov-timeOut" value="${esc(prefOut)}" /></label>
      </div>
      <p class="hint" style="margin:6px 2px 14px">Ignored for Day Off / Leave. Leave blank if the actual times aren't known — the day still counts, just with no hours logged.</p>
      <div class="field">
        <label>Note (required)</label>
        <textarea id="ov-note" placeholder="What happened, in your own words...">${esc(existing ? existing.note : '')}</textarea>
      </div>
      <p class="err" id="ov-err"></p>
      <div class="modal-foot">
        <div>${existing ? '<button class="btn danger small" id="ov-clear">Clear override</button>' : '<span></span>'}</div>
        <div class="right">
          <button class="btn ghost" id="ov-cancel">Cancel</button>
          <button class="btn primary" id="ov-save">Save</button>
        </div>
      </div>
    </div>`
  $('#ovModal').classList.remove('hidden')

  $('#ov-cancel').addEventListener('click', closeOverrideModal)
  $('#ov-save').addEventListener('click', async () => {
    const status = $('#ov-status').value
    const note = $('#ov-note').value.trim()
    const timeIn = $('#ov-timeIn').value
    const timeOut = $('#ov-timeOut').value
    if (!note) { $('#ov-err').textContent = 'A note is required.'; return }
    try {
      await api('/api/overrides', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin, date, status, note, timeIn, timeOut }) })
      closeOverrideModal(); runTimesheet()
    } catch (e) { $('#ov-err').textContent = e.message }
  })
  if (existing) {
    $('#ov-clear').addEventListener('click', async () => {
      if (!confirm('Clear this override? The day falls back to the normal computed status.')) return
      try {
        await api(`/api/overrides?pin=${encodeURIComponent(pin)}&date=${date}`, { method: 'DELETE' })
        closeOverrideModal(); runTimesheet()
      } catch (e) { $('#ov-err').textContent = e.message }
    })
  }
}
function closeOverrideModal() { $('#ovModal').classList.add('hidden'); $('#ovModal').innerHTML = '' }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOverrideModal() })
// The overlay itself is a permanent element (only its children are replaced on
// each open), so this listener is attached once here — not inside
// openOverrideModal, which would stack a duplicate on every cell click.
$('#ovModal').addEventListener('click', e => { if (e.target.id === 'ovModal') closeOverrideModal() })

function shiftTsMonth(delta) {
  const val = $('#ts-month').value; if (!val) return
  const [y, m] = val.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  $('#ts-month').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  runTimesheet()
}
$('#tsPrevMonth').addEventListener('click', () => shiftTsMonth(-1))
$('#tsNextMonth').addEventListener('click', () => shiftTsMonth(1))

$('#runTs').addEventListener('click', runTimesheet)
$('#ts-search').addEventListener('input', renderTimesheet)
$('#ts-device').addEventListener('change', runTimesheet)
$('#ts-group').addEventListener('change', runTimesheet)
$('#expTs').addEventListener('click', () => { window.location = '/api/export/timesheet?' + tsParams().toString() })

// ── staff ──────────────────────────────────────────────────
let empData = {}
let editingPin = null   // PIN currently in edit mode, or null

async function loadEmployees() {
  empData = await api('/api/employees')
  renderEmployees()
}

function groupSelectHtml(selected) {
  return `<option value=""${!selected ? ' selected' : ''}>— None —</option>` +
    `<option value="office"${selected === 'office' ? ' selected' : ''}>Office Staff</option>` +
    `<option value="worker"${selected === 'worker' ? ' selected' : ''}>Worker</option>`
}

function renderEmployees() {
  const q = ($('#e-search').value || '').toLowerCase()
  const gf = $('#e-groupFilter').value
  const rows = Object.entries(empData)
    .filter(([pin, v]) => !q || pin.toLowerCase().includes(q) || ((v && v.name) || '').toLowerCase().includes(q))
    .filter(([pin, v]) => !gf || (v && v.group) === gf)
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
  const tb = $('#empTable tbody')
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="7"><div class="empty">${Object.keys(empData).length ? 'No staff match your filters.' : 'No staff yet.'}</div></td></tr>`
    return
  }
  tb.innerHTML = rows.map(([pin, v]) => {
    if (editingPin === pin) {
      return `<tr>
        <td><input type="text" data-f="pin" value="${esc(pin)}" style="width:70px" class="mono" /></td>
        <td><input type="text" data-f="name" value="${esc((v && v.name) || '')}" style="width:160px" /></td>
        <td><select data-f="group" style="padding:5px 9px;font-size:12px">${groupSelectHtml(v && v.group)}</select></td>
        <td><input type="time" data-f="timeIn" value="${esc((v && v.timeIn) || '')}" /></td>
        <td><input type="time" data-f="timeOut" value="${esc((v && v.timeOut) || '')}" /></td>
        <td><div class="offdays" data-f="offDays">${offDaysHtml(v && v.offDays)}</div></td>
        <td class="actions">
          <button class="btn small primary" data-save="${esc(pin)}">Save</button>
          <button class="btn small ghost" data-cancel="${esc(pin)}">Cancel</button>
        </td></tr>`
    }
    return `<tr>
      <td class="mono">${esc(pin)}</td>
      <td><b>${esc((v && v.name) || '')}</b></td>
      <td>${groupChip(v && v.group)}</td>
      <td class="mono">${esc((v && v.timeIn) || '—')}</td>
      <td class="mono">${esc((v && v.timeOut) || '—')}</td>
      <td class="mono">${(v && v.offDays && v.offDays.length ? v.offDays : [0, 6]).map(d => DOW_SHORT[d]).join(', ')}</td>
      <td class="actions">
        <button class="btn small" data-edit="${esc(pin)}">Edit</button>
        <button class="btn small danger" data-emp="${esc(pin)}">Remove</button>
      </td></tr>`
  }).join('')
}
$('#e-search').addEventListener('input', renderEmployees)
$('#e-groupFilter').addEventListener('change', renderEmployees)

$('#e-offDays').innerHTML = offDaysHtml([0, 6])

$('#saveEmp').addEventListener('click', async () => {
  $('#empErr').textContent = ''
  const pin = $('#e-pin').value.trim(); if (!pin) { $('#empErr').textContent = 'PIN is required.'; return }
  const name = $('#e-name').value.trim(); if (!name) { $('#empErr').textContent = 'Name is required.'; return }
  const offDays = readOffDays($('#e-offDays'))
  try {
    await api('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, name, group: $('#e-group').value, timeIn: $('#e-timeIn').value, timeOut: $('#e-timeOut').value, offDays }) })
    $('#e-pin').value = ''; $('#e-name').value = ''; $('#e-group').value = ''; $('#e-timeIn').value = ''; $('#e-timeOut').value = ''
    $('#e-offDays').innerHTML = offDaysHtml([0, 6])
    loadEmployees()
  } catch (e) { $('#empErr').textContent = e.message }
})

$('#empTable').addEventListener('click', async e => {
  const editBtn = e.target.closest('[data-edit]')
  const cancelBtn = e.target.closest('[data-cancel]')
  const saveBtn = e.target.closest('[data-save]')
  const rmBtn = e.target.closest('[data-emp]')

  if (editBtn) { editingPin = editBtn.dataset.edit; renderEmployees(); return }
  if (cancelBtn) { editingPin = null; renderEmployees(); return }

  if (saveBtn) {
    const pin = saveBtn.dataset.save
    const row = saveBtn.closest('tr')
    const get = f => row.querySelector(`[data-f="${f}"]`).value
    const name = get('name').trim()
    if (!name) { alert('Name cannot be empty. Use Remove to delete a staff member instead.'); return }
    const newPin = get('pin').trim()
    if (!newPin) { alert('PIN cannot be empty.'); return }
    if (newPin !== pin && !confirm(`Change PIN ${pin} to ${newPin}? This person's punch history and any day overrides move with it.`)) return
    const offDays = readOffDays(row.querySelector('[data-f="offDays"]'))
    try {
      await api('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, newPin, name, group: get('group'), timeIn: get('timeIn'), timeOut: get('timeOut'), offDays }) })
      editingPin = null
      loadEmployees()
    } catch (err) { alert(err.message) }
    return
  }

  if (rmBtn) {
    if (!confirm(`Remove PIN ${rmBtn.dataset.emp} from staff? Their punches stay in the database.`)) return
    await api('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: rmBtn.dataset.emp, name: '' }) })
    loadEmployees()
  }
})

// ── settings ────────────────────────────────────────────────
async function loadSettings() {
  const s = await api('/api/settings')
  $('#s-workStart').value = s.workStart || ''; $('#s-workEnd').value = s.workEnd || ''; $('#s-grace').value = s.graceMinutes ?? 0
  $('#s-tz').value = s.timezone || ''
}
$('#saveSettings').addEventListener('click', async () => {
  await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workStart: $('#s-workStart').value, workEnd: $('#s-workEnd').value, graceMinutes: Number($('#s-grace').value) }) })
  $('#setMsg').textContent = 'Saved.'; setTimeout(() => $('#setMsg').textContent = '', 1500)
})

// ── init ────────────────────────────────────────────────────
function defaultDates() {
  const now = new Date(), first = new Date(now.getFullYear(), now.getMonth(), 1)
  const iso = d => d.toLocaleDateString('en-CA')
  $('#r-from').value = iso(first); $('#r-to').value = iso(now)
  $('#ts-month').value = iso(now).slice(0, 7)
}
// ── users (login accounts) ─────────────────────────────────
async function loadUsers() {
  const users = await api('/api/users')
  $('#userTable tbody').innerHTML = users.length ? users.map(u => {
    const admin = u.role === 'admin'
    return `<tr>
    <td><b>${esc(u.username)}</b></td>
    <td>${admin ? '<span class="chip adms">Admin</span>' : '<span class="mono">User</span>'}</td>
    <td class="actions">
      <button class="btn small" data-role="${esc(u.username)}" data-to="${admin ? 'user' : 'admin'}">${admin ? 'Make user' : 'Make admin'}</button>
      <button class="btn small" data-pw="${esc(u.username)}">Set password</button>
      <button class="btn small" data-rn="${esc(u.username)}">Rename</button>
      <button class="btn small danger" data-du="${esc(u.username)}">Delete</button>
    </td></tr>`
  }).join('') : '<tr><td colspan="3"><div class="empty">No users.</div></td></tr>'
}
$('#addUser').addEventListener('click', async () => {
  $('#userErr').textContent = ''
  try {
    await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#nu-name').value, password: $('#nu-pass').value, role: $('#nu-role').value }) })
    $('#nu-name').value = ''; $('#nu-pass').value = ''; $('#nu-role').value = 'user'; loadUsers()
  } catch (e) { $('#userErr').textContent = e.message }
})
$('#userTable').addEventListener('click', async e => {
  const role = e.target.closest('[data-role]'), pw = e.target.closest('[data-pw]'), rn = e.target.closest('[data-rn]'), du = e.target.closest('[data-du]')
  try {
    if (role) {
      await api('/api/users', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: role.dataset.role, role: role.dataset.to }) }); loadUsers(); refreshMe()
    } else if (pw) {
      const p = prompt(`New password for "${pw.dataset.pw}":`)
      if (p) { await api('/api/users', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: pw.dataset.pw, password: p }) }); alert('Password updated.') }
    } else if (rn) {
      const n = prompt(`New username for "${rn.dataset.rn}":`, rn.dataset.rn)
      if (n && n.trim() && n !== rn.dataset.rn) { await api('/api/users', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: rn.dataset.rn, newUsername: n }) }); loadUsers(); refreshMe() }
    } else if (du) {
      if (confirm(`Delete user "${du.dataset.du}"? They will no longer be able to sign in.`)) { await api('/api/users?username=' + encodeURIComponent(du.dataset.du), { method: 'DELETE' }); loadUsers() }
    }
  } catch (err) { alert(err.message) }
})

// ── auth: show user + logout ───────────────────────────────
$('#logout').addEventListener('click', async () => { try { await fetch('/api/logout', { method: 'POST' }) } catch {} location.href = '/login' })
async function refreshMe() {
  try {
    const m = await api('/api/me')
    if (m && m.username) $('#who').textContent = m.username
    const btn = document.querySelector('[data-tab="users"]')
    if (btn) btn.hidden = !(m && m.admin)   // Users tab is admin-only
  } catch { /* ignore */ }
}
refreshMe()

defaultDates(); loadStatus(); loadLive(); loadDevices(); loadSettings()
setInterval(loadStatus, 15000)
