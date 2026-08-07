require('dotenv').config()
const https = require('https')

const projectRef = 'nwbmxdtwebhrqzccozoc'
// Set SUPABASE_ACCESS_TOKEN in your .env (personal access token from supabase.com/account/tokens)
const accessToken = process.env.SUPABASE_ACCESS_TOKEN
if (!accessToken) { console.error('Missing SUPABASE_ACCESS_TOKEN in .env'); process.exit(1) }

async function runSQL(sql) {
  const body = JSON.stringify({ query: sql })
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.supabase.com',
      path: `/v1/projects/${projectRef}/database/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function main() {
  // Step 1: Enable extensions
  console.log('Enabling pg_cron and pg_net extensions...')
  const ext = await runSQL(`
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
  `)
  console.log('Extensions:', ext.status, ext.body)

  // Step 2: Remove old job if exists (idempotent)
  console.log('\nRemoving old cron job if exists...')
  const del = await runSQL(`
    select cron.unschedule('pull-devices-5min');
  `)
  console.log('Unschedule:', del.status, del.body)

  // Step 3: Create the new cron job
  console.log('\nCreating cron job (every 5 min)...')
  const create = await runSQL(`
    select cron.schedule(
      'pull-devices-5min',
      '*/5 * * * *',
      $$
        select net.http_get(
          url     := 'https://songfawatertanks-attendance.vercel.app/api/cron/pull',
          headers := '{"Authorization": "Bearer 88449aadfbf65421594def5edd4c75be9935ef2d20dddced372f63ba5367c0db"}'::jsonb
        );
      $$
    );
  `)
  console.log('Create:', create.status, create.body)

  // Step 4: Verify
  console.log('\nVerifying scheduled jobs...')
  const verify = await runSQL(`
    select jobid, jobname, schedule, active from cron.job;
  `)
  console.log('Jobs:', verify.status, verify.body)
}

main().catch(console.error)
