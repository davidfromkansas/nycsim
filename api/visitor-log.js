/* Vercel function for GET /api/visitor-log — key-protected return report. */
const { handleVisitorLog } = require('../lib/visitor-log-view');

module.exports = async (req, res) => {
  try { await handleVisitorLog(req, res); }
  catch (e) {
    console.error(new Date().toISOString(), 'visitor-log request error:', e.message || e);
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'internal' }));
  }
};
