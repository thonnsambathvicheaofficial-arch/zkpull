const sb = require('../lib/supabase');
(async () => {
  const { data: e21 } = await sb.from('employees').select('*').eq('pin', '21').maybeSingle();
  const { data: e429 } = await sb.from('employees').select('*').eq('pin', '429').maybeSingle();
  console.log('PIN 21:', e21);
  console.log('PIN 429:', e429);
})();
