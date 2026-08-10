const { pullAll } = require('../lib/zkpull');
(async () => {
  console.log('Starting full pull on all devices...');
  const result = await pullAll({ full: true });
  console.log('Pull result:', JSON.stringify(result, null, 2));
})();
