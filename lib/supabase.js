// Single Supabase client for the whole app. Uses the SERVICE key — this file is
// only ever required server-side (Express routes / Vercel functions), never
// bundled to a browser. RLS is enabled with no policies on every table, so only
// the service key (which bypasses RLS) can read or write anything.
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY. Set them in .env (local) or the Vercel project\'s Environment Variables.')
}

module.exports = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
