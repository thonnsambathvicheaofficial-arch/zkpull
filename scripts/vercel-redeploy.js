const fs = require('fs')
const env = fs.readFileSync('.env', 'utf8')
const token = env.match(/vercel_access token:\s*(\S+)/)[1]
const PREV_DEPLOY_ID = process.argv[2] || 'dpl_BZ3qcVNA8ZJWtf4gnq8zD4eSeeqn'

async function main() {
  const res = await fetch(`https://api.vercel.com/v13/deployments?forceNew=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'songfawatertanks-attendance', deploymentId: PREV_DEPLOY_ID, target: 'production' }),
  })
  const data = await res.json()
  console.log('status:', res.status)
  console.log(JSON.stringify({ id: data.id, url: data.url, readyState: data.readyState, error: data.error }, null, 2))
}
main()
