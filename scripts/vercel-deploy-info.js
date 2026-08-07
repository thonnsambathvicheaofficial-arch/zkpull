const fs = require('fs')
const env = fs.readFileSync('.env', 'utf8')
const token = env.match(/vercel_access token:\s*(\S+)/)[1]
const DEPLOY_ID = process.argv[2] || 'dpl_BZ3qcVNA8ZJWtf4gnq8zD4eSeeqn'

async function main() {
  const res = await fetch(`https://api.vercel.com/v13/deployments/${DEPLOY_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json()
  console.log('readyState:', data.readyState)
  console.log('functions:', JSON.stringify(data.functions, null, 2))
  console.log('routes:', JSON.stringify(data.routes, null, 2))
  console.log('builds:', JSON.stringify((data.builds || []).map(b => ({ src: b.src, use: b.use, output: (b.output || []).map(o => o.path) })), null, 2))
}
main()
