const sb = require('../lib/supabase');
const d = new Date();
const pad = n => String(n).padStart(2, '0');
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
(async () => {
  const { data } = await sb.from('punches').select('*').gte('ts', today + ' 00:00:00').lte('ts', today + ' 23:59:59');
  const { data: emps } = await sb.from('employees').select('pin');
  const empPins = new Set(emps.map(e => e.pin));
  const unmapped = data.filter(p => !empPins.has(p.pin));
  console.log('Unmapped punches for today:', unmapped);
})();
