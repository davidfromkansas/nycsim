/* Vercel function for private feedback submissions. */
const { handleFeedback } = require('../lib/feedback-core');

module.exports = async (req, res) => {
  try { await handleFeedback(req, res); }
  catch (e) {
    console.error(new Date().toISOString(), 'feedback request error:', e.message || e);
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'internal' }));
  }
};
