/* Vercel function for /api/home — sign-in + saved home (see lib/home-core.js).
   A real file under api/ wins over the vercel.json rewrite for exactly /api/home;
   home-core deliberately uses ONE route (action in the POST body) so nothing
   nested ever falls through to the cached-feed dispatcher. */
const { handleHome } = require('../lib/home-core');

module.exports = async (req, res) => {
  try {
    await handleHome(req, res);
  } catch (e) {
    console.error(new Date().toISOString(), 'home request error:', e.message || e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'internal' }));
  }
};
