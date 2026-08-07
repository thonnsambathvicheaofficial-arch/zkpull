const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const env = fs.readFileSync(path.join(root, '.env'), 'utf8')
const get = (label) => env.match(new RegExp(label + ':\\s*(\\S+)'))[1]
const url = get('Project URL')
const accessToken = get('access token')
const ref = new URL(url).hostname.split('.')[0]

const sql = `
-- Dedup key is (pin, ts) — a PIN is global across devices, so a re-pull of the
-- same event under a different device_id must still collide (see lib/store.js).
drop index if exists punches_dedup;
create unique index if not exists punches_dedup on punches (pin, ts);
`

async function run(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  return { status: res.status, text }
}

run(sql).then(r => { console.log('status:', r.status); console.log(r.text) })
