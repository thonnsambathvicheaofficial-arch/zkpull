const fs = require('fs')
const env = fs.readFileSync('.env', 'utf8')
const token = env.match(/vercel_access token:\s*(\S+)/)[1]
const PROJECT_ID = 'prj_8IxiEONSl9JFS9ZKcOZnedANH2bu'

async function main() {
  const res = await fetch(`https://api.vercel.com/v9/projects/${PROJECT_ID}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ framework: null }),
  })
  const data = await res.json()
  console.log('status:', res.status)
  console.log('framework now:', data.framework)
}
main()
