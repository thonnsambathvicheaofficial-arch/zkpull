const fs = require('fs')
const env = fs.readFileSync('.env', 'utf8')
const token = env.match(/vercel_access token:\s*(\S+)/)[1]

async function main() {
  const res = await fetch(`https://api.vercel.com/v4/aliases/songfawatertanks-attendance.vercel.app`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json()
  console.log(res.status, JSON.stringify(data, null, 2))
}
main()
