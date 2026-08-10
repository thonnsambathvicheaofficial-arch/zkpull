const sb = require('../lib/supabase');
const d = new Date();
const pad = n => String(n).padStart(2, '0');
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
(async () => {
  const { data: punches } = await sb.from('punches').select('pin').gte('ts', today + ' 00:00:00').lte('ts', today + ' 23:59:59');
  const { data: emps } = await sb.from('employees').select('pin, name, group').eq('group', 'office');
  
  const punchedPins = new Set(punches.map(p => p.pin));
  
  const accountedFor = emps.filter(e => punchedPins.has(e.pin));
  const missing = emps.filter(e => !punchedPins.has(e.pin));
  
  console.log('--- Office Staff Accounted For ---');
  accountedFor.forEach(e => console.log(`[✔] ${e.name} (PIN: ${e.pin})`));
  
  console.log('\n--- Office Staff MISSING (No punch today) ---');
  missing.forEach(e => console.log(`[ ] ${e.name} (PIN: ${e.pin})`));
  
  if (missing.length === 0) {
    console.log('\nAll mapped office staff are accounted for today!');
  } else {
    console.log(`\n${missing.length} office staff have NOT punched in today.`);
  }
})();
