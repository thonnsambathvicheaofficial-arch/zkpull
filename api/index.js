// Vercel serverless entry point — the whole Express app, unchanged. server.js
// only calls app.listen() when run directly (`node server.js`), so requiring
// it here just gets the app object for Vercel to invoke per-request.
module.exports = require('../server')
