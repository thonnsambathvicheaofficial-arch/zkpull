const fs = require('fs')
const env = fs.readFileSync('.env', 'utf8')
const token = env.match(/vercel_access token:\s*(\S+)/)[1]
const PROJECT_ID = 'prj_8IxiEONSl9JFS9ZKcOZnedANH2bu'

async function main() {
  const res = await fetch(`https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&limit=3`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json()
  for (const d of data.deployments || []) {
    console.log(d.uid, '|', d.readyState, '|', d.url, '|', new Date(d.createdAt).toISOString(), '|', d.meta && d.meta.githubCommitMessage)
  }
}
main()
