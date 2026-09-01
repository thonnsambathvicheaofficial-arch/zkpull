// One-off cleanup: move B3-C's historical phantom midnight punches (see
// MIDNIGHT_ARTIFACT_* in lib/zkpull.js — a device housekeeping routine stamps
// a recurring group of PINs at 00:00:0X most nights) out of `punches` and
// into `corrupted_punches`, so past reports stop being inflated by them.
// Nothing is deleted outright: the DELETE...RETURNING feeds straight into the
// INSERT in one atomic statement, so a row is either moved whole or the
// transaction fails and nothing changes.
//
// Usage:
//   node scripts/quarantine_midnight_artifacts.js            # dry run (counts only)
//   node scripts/quarantine_midnight_artifacts.js --apply     # actually move them

const fs = require('fs')
const path = require('path')

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
const get = (label) => env.match(new RegExp(label + ':\\s*(\\S+)'))[1]
const url = get('Project URL')
const accessToken = get('access token')
const ref = new URL(url).hostname.split('.')[0]

const apply = process.argv.includes('--apply')

// ts >= 2020-01-01 excludes the separate legacy-garbage-date rows (year 2000,
// some with blank PIN) that happen to also land at hour=0 — those are the
// out-of-range-timestamp bug (same class as K40's 2119 dates), not this
// device's recurring-PIN midnight routine, and get their own reason label
// via a separate cleanup so they aren't mislabeled here.
const WHERE = `
  device_id = (select id from devices where name = 'B3-C')
  and ts >= '2020-01-01'
  and extract(hour from ts) = 0
  and extract(minute from ts) < 2
`

const dryRunSql = `
  select count(*) as n, min(ts) as earliest, max(ts) as latest, count(distinct pin) as distinct_pins
  from punches
  where ${WHERE};
`

const moveSql = `
  with moved as (
    delete from punches
    where ${WHERE}
    returning device_id, serial, pin, ts, verify, status, source
  )
  insert into corrupted_punches (device_id, device_name, serial, pin, ts, verify, status, source, detected_at, reason)
  select m.device_id, d.name, m.serial, m.pin, m.ts, m.verify, m.status, m.source, now(), 'midnight_artifact'
  from moved m join devices d on d.id = m.device_id
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
