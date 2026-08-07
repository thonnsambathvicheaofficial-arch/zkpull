const fs = require('fs')
const env = fs.readFileSync('.env', 'utf8')
const token = env.match(/vercel_access token:\s*(\S+)/)[1]
const DEPLOY_ID = process.argv[2]

async function main() {
  const res = await fetch(`https://api.vercel.com/v2/deployments/${DEPLOY_ID}/events?builds=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  console.log('status:', res.status)
  console.log(text)
}
main()
