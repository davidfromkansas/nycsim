/* Vercel function for GET /api/feedback-log — AGENT_LOG_KEY protected. */
const { handleFeedbackView } = require('../lib/feedback-view');

module.exports = async (req, res) => {
  try { await handleFeedbackView(req, res); }
  catch (e) {
    console.error(new Date().toISOString(), 'feedback-log request error:', e.message || e);
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'internal' }));
  }
};
