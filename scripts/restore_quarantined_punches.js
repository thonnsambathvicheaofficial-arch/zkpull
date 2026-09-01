// Restore specific corrupted_punches rows back into `punches` — for the case
// where a quarantine rule (RTC sanity, or B3-C's midnight-artifact rule) is
// right in general but wrong for a specific, confirmed instance: e.g. a
// worker who genuinely worked a night shift on an ad-hoc, case-by-case basis
// (not a standing schedule change, so the device-wide/date-range quarantine
// rule stays as-is — this only un-quarantines the exact rows named).
//
// Same atomic, non-lossy pattern as the quarantine scripts, reversed:
// DELETE...RETURNING from corrupted_punches feeds straight into INSERT into
// punches, ON CONFLICT (pin,ts) DO NOTHING (a no-op if it's somehow already
// back in punches) — a row is either moved whole or nothing changes.
//
// Usage:
//   node scripts/restore_quarantined_punches.js <id> [<id> ...]              # dry run
//   node scripts/restore_quarantined_punches.js --apply <id> [<id> ...]      # actually restore

const fs = require('fs')
const path = require('path')

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
const get = (label) => env.match(new RegExp(label + ':\\s*(\\S+)'))[1]
const url = get('Project URL')
const accessToken = get('access token')
const ref = new URL(url).hostname.split('.')[0]

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const ids = args.filter(a => a !== '--apply')

if (!ids.length) {
  console.error('Usage: node scripts/restore_quarantined_punches.js [--apply] <corrupted_punches id> [<id> ...]')
  process.exit(1)
}

// Postgres array literal — ids are UUIDs we generated ourselves (from a prior
// SELECT), not user input, but quote-escape defensively anyway.
const idList = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',')

const dryRunSql = `select id, pin, ts, device_id, reason from corrupted_punches where id in (${idList});`

const restoreSql = `
  with restored as (
    delete from corrupted_punches
    where id in (${idList})
    returning device_id, serial, pin, ts::timestamp as ts, verify, status, source
  )
  insert into punches (device_id, serial, pin, ts, verify, status, source)
  select device_id, serial, pin, ts, verify, status, source
  from restored
  on conflict (pin, ts) do nothing
  returning pin, ts;
`

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  const text = await res.text()
  return { status: res.status, text }
}

async function main() {
  console.log(apply ? '=== APPLYING (restoring rows) ===' : '=== DRY RUN (nothing changes) ===')
  const dry = await query(dryRunSql)
  console.log('rows matched:', dry.status)
  console.log(dry.text)

  if (!apply) {
    console.log('\nRe-run with --apply to actually restore these rows.')
    return
  }

  const moved = await query(restoreSql)
  console.log('\nrestore status:', moved.status)
  console.log(moved.text)
}

main().catch(e => { console.error(e); process.exit(1) })
