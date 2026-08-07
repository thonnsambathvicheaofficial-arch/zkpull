const fs = require('fs')
const env = fs.readFileSync('.env', 'utf8')
const token = env.match(/vercel_access token:\s*(\S+)/)[1]
const PROJECT_ID = 'prj_8IxiEONSl9JFS9ZKcOZnedANH2bu'

async function main() {
  const res = await fetch(`https://api.vercel.com/v9/projects/${PROJECT_ID}/domains`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json()
  console.log(JSON.stringify(data, null, 2))
}
main()
