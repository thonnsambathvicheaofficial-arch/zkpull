require('dotenv').config()
async function main() {
  const res = await fetch('https://api.vercel.com/v9/projects', {
    headers: { Authorization: `Bearer ${process.env.VERCEL_ACCESS_TOKEN || require('fs').readFileSync('.env', 'utf8').match(/vercel_access token:\s*(\S+)/)[1]}` },
  })
  const data = await res.json()
  console.log('status:', res.status)
  console.log(JSON.stringify((data.projects || data).map(p => ({ id: p.id, name: p.name, link: p.link && p.link.repo })), null, 2))
}
main()
