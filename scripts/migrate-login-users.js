require('dotenv').config()
const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')
const sb = require('../lib/supabase')

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'))
  for (const u of cfg.users) {
    const password_hash = await bcrypt.hash(String(u.password), 10)
    const { error } = await sb.from('login_users').upsert(
      { username: u.username, password_hash, role: u.role === 'admin' ? 'admin' : 'user' },
      { onConflict: 'username' },
    )
    if (error) throw new Error(error.message)
    console.log(`migrated login user: ${u.username} (${u.role})`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
