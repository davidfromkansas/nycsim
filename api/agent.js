/* Vercel function for POST /api/agent — the City Concierge LLM agent.
   A real file under api/ wins over the vercel.json rewrite to /api/index,
   so this route never touches the cached-feed dispatcher. All logic lives
   in lib/agent-core.js (shared with server.js for local dev). */
const { handleAgent } = require('../lib/agent-core');

module.exports = async (req, res) => {
  try {
    await handleAgent(req, res);
  } catch (e) {
    console.error(new Date().toISOString(), 'agent request error:', e.message || e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'internal' }));
  }
};
