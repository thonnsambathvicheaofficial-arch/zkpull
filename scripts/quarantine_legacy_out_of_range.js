// One-off cleanup: lib/zkpull.js has quarantined out-of-range timestamps
// (TS_MIN/tsMax — see that file) since commit 11936a6, but only going
// forward — rows already sitting in `punches` from BEFORE that fix (or
// re-detected on a later pull, which writes to corrupted_punches but never
// deletes the original punches row) are still there, still corrupting past
// reports. This moves every punches row outside the same TS_MIN/tsMax window
// the live code uses into corrupted_punches, across ALL devices.
//
// Nothing is deleted outright: the DELETE...RETURNING feeds straight into the
// INSERT in one atomic statement, so a row is either moved whole or the
// transaction fails and nothing changes. ON CONFLICT (pin,ts) DO NOTHING
// means a row already sitting in corrupted_punches (e.g. K40's 18 rows,
// re-detected on a pull after the table existed) is deleted from `punches`
// without erroring or duplicating.
//
// Usage:
//   node scripts/quarantine_legacy_out_of_range.js            # dry run (counts only)
//   node scripts/quarantine_legacy_out_of_range.js --apply     # actually move them

const fs = require('fs')
const path = require('path')

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
const get = (label) => env.match(new RegExp(label + ':\\s*(\\S+)'))[1]
const url = get('Project URL')
const accessToken = get('access token')
const ref = new URL(url).hostname.split('.')[0]

const apply = process.argv.includes('--apply')

// Same bounds as TS_MIN / tsMax() in lib/zkpull.js.
const WHERE = `ts < '2020-01-01' or ts > (now() + interval '2 years')`

const dryRunSql = `
  select device_id, count(*) as n, min(ts) as earliest, max(ts) as latest
  from punches
  where ${WHERE}
  group by device_id;
`

const moveSql = `
  with moved as (
    delete from punches
    where ${WHERE}
    returning device_id, serial, pin, ts, verify, status, source
  )
  insert into corrupted_punches (device_id, device_name, serial, pin, ts, verify, status, source, detected_at, reason)
  select m.device_id, d.name, m.serial, m.pin, m.ts, m.verify, m.status, m.source, now(), 'out_of_range_timestamp'
  from moved m left join devices d on d.id = m.device_id
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
  console.log(apply ? '=== APPLYING (moving rows) ===' : '=== DRY RUN (counts only, nothing changes) ===')
  const dry = await query(dryRunSql)
  console.log('dry-run status:', dry.status)
  console.log(dry.text)

  if (!apply) {
    console.log('\nRe-run with --apply to actually move these rows.')
    return
  }

  const moved = await query(moveSql)
  console.log('\nmove status:', moved.status)
  console.log(moved.text)
}

main().catch(e => { console.error(e); process.exit(1) })
