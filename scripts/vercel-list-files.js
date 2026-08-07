const fs = require('fs')
const env = fs.readFileSync('.env', 'utf8')
const token = env.match(/vercel_access token:\s*(\S+)/)[1]
const DEPLOY_ID = process.argv[2]

async function main() {
  const res = await fetch(`https://api.vercel.com/v6/deployments/${DEPLOY_ID}/files`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json()
  console.log(res.status)
  const walk = (nodes, prefix = '') => {
    for (const n of nodes) {
      console.log(prefix + n.name, n.type)
      if (n.children) walk(n.children, prefix + '  ')
    }
  }
  walk(data)
}
main()
