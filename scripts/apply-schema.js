const fs = require('fs')
const path = require('path')

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
const get = (label) => env.match(new RegExp(label + ':\\s*(\\S+)'))[1]
const url = get('Project URL')
const accessToken = get('access token')
const ref = new URL(url).hostname.split('.')[0]

const sql = fs.readFileSync(path.join(__dirname, '..', 'cloud', 'supabase', 'schema.sql'), 'utf8')

async function main() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  const text = await res.text()
  console.log('status:', res.status)
  console.log(text)
}

main().catch(e => { console.error(e); process.exit(1) })
