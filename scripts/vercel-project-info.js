const fs = require('fs')
const env = fs.readFileSync('.env', 'utf8')
const token = env.match(/vercel_access token:\s*(\S+)/)[1]
const PROJECT_ID = 'prj_8IxiEONSl9JFS9ZKcOZnedANH2bu'

async function main() {
  const res = await fetch(`https://api.vercel.com/v9/projects/${PROJECT_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json()
  console.log('framework:', data.framework)
  console.log('rootDirectory:', data.rootDirectory)
  console.log('buildCommand:', data.buildCommand)
  console.log('outputDirectory:', data.outputDirectory)
  console.log('devCommand:', data.devCommand)
  console.log('installCommand:', data.installCommand)
}
main()
