/* Vercel function for POST /api/visit — 90-day pseudonymous return tracking. */
const { handleVisit } = require('../lib/visitor-log');

module.exports = async (req, res) => {
  try { await handleVisit(req, res); }
  catch (e) {
    console.error(new Date().toISOString(), 'visit request error:', e.message || e);
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'internal' }));
  }
};
