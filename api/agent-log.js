/* Vercel function for GET /api/agent-log — the private Concierge usage viewer.
   A real file under api/ beats the vercel.json rewrite. Gated by AGENT_LOG_KEY;
   inert (404) until that env var is set. server.js mirrors it for local dev. */
const { handleAgentLog } = require('../lib/agent-log-view');

module.exports = async (req, res) => {
  try {
    await handleAgentLog(req, res);
  } catch (e) {
    console.error(new Date().toISOString(), 'agent-log request error:', e.message || e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'internal' }));
  }
};
