const sb = require('../lib/supabase');

(async () => {
  console.log('Fixing data for Eng Minea...');

  // 1. Update PIN 21: Set group to 'office', clear aliases
  const { error: err1 } = await sb.from('employees')
    .update({ group: 'office', aliases: [] })
    .eq('pin', '21');

  if (err1) {
    console.error('Error updating PIN 21:', err1);
  } else {
    console.log('Successfully updated PIN 21 to Office staff and cleared aliases.');
  }

  // 2. Update PIN 429: Set group to 'worker', make sure name is 'Eng Minea'
  const { error: err2 } = await sb.from('employees')
    .update({ group: 'worker', name: 'Eng Minea' })
    .eq('pin', '429');

  if (err2) {
    console.error('Error updating PIN 429:', err2);
  } else {
    console.log('Successfully updated PIN 429 to Worker.');
  }

  // Verify
  const { data: e21 } = await sb.from('employees').select('*').eq('pin', '21').maybeSingle();
  const { data: e429 } = await sb.from('employees').select('*').eq('pin', '429').maybeSingle();
  console.log('\n--- VERIFICATION ---');
  console.log('PIN 21:', e21);
  console.log('PIN 429:', e429);
})();
