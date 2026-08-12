// backup_pull.js — Force a full read from every TCP-pull device and
// upsert all records into the cloud database.
// Run: node scripts/backup_pull.js
process.env.TZ = 'Asia/Phnom_Penh'
require('dotenv').config()

const { pullAll } = require('../lib/zkpull')
const ZKLib = require('node-zklib')

;(async () => {
  console.log('\n🔄  Starting full backup pull from all devices…\n')
  try {
    const result = await pullAll({ full: true })
    console.log(`\n✅  Done. ${result.devices} device(s) processed.\n`)
    for (const r of result.results) {
      if (r.ok) {
        const note = r.skippedRead ? '(no change — skipped read)' : `${r.pushed} new records pushed, ${r.totalOnDevice} on device`
        console.log(`  ✔  ${r.device}: ${note}  [${r.ms}ms]`)
      } else {
        console.log(`  ✖  ${r.device}: FAILED — ${r.error}`)
      }
    }
    console.log('')
  } catch (err) {
    console.error('Fatal error:', err.message)
    process.exit(1)
  }
})()
