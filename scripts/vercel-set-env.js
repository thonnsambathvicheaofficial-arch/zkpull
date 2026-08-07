require('dotenv').config()
const fs = require('fs')

const env = fs.readFileSync('.env', 'utf8')
const token = env.match(/vercel_access token:\s*(\S+)/)[1]
const PROJECT_ID = 'prj_8IxiEONSl9JFS9ZKcOZnedANH2bu'

const vars = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  SESSION_SECRET: process.env.SESSION_SECRET,
}

async function setVar(key, value) {
  const res = await fetch(`https://api.vercel.com/v10/projects/${PROJECT_ID}/env`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value, type: 'encrypted', target: ['production', 'preview', 'development'] }),
  })
  const data = await res.json()
  console.log(key, '->', res.status, res.ok ? 'ok' : JSON.stringify(data))
}

async function main() {
  for (const [k, v] of Object.entries(vars)) {
    if (!v) { console.log(k, '-> SKIPPED (empty)'); continue }
    await setVar(k, v)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
