/* GET /api/feedback-log — private reader for feedback submissions.
   Uses the same AGENT_LOG_KEY gate and failed-password throttle as
   /api/agent-log and /api/visitor-log. Blob URLs never reach clients. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listFeedback, readFeedback, enabled } = require('./feedback-core');
const { sendJSON } = require('./api-core');

function viewerKey() {
  if (process.env.AGENT_LOG_KEY) return process.env.AGENT_LOG_KEY;
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    const m = env.match(/^AGENT_LOG_KEY="?([^"\n]+)"?$/m);
    return m ? m[1] : null;
  } catch { return null; }
}
function keyMatches(got, want) {
  const a = Buffer.from(String(got || '')), b = Buffer.from(String(want || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const BAD = new Map();
const BAD_MAX = 10, BAD_WINDOW_MS = 3600_000;
function authThrottled(ip) {
  const now = Date.now(), attempts = (BAD.get(ip) || []).filter(t => now - t < BAD_WINDOW_MS);
  BAD.set(ip, attempts);
  if (BAD.size > 5000) BAD.clear();
  return attempts.length >= BAD_MAX;
}
function noteBadKey(ip) { BAD.get(ip).push(Date.now()); }
async function listAll(prefix) {
  let cursor = null, pages = 0, blobs = [];
  do {
    const page = await listFeedback(prefix, 1000, cursor);
    blobs.push(...(page.blobs || []));
    cursor = page.hasMore ? page.cursor : null;
    pages++;
  } while (cursor && pages < 100);
  return blobs;
}
async function readAll(blobs) {
  const rows = [];
  for (let i = 0; i < blobs.length; i += 50) {
    rows.push(...await Promise.all(blobs.slice(i, i + 50).map(b =>
      readFeedback(b.downloadUrl || b.url).catch(() => null))));
  }
  return rows.filter(Boolean);
}

async function handleFeedbackView(req, res) {
  if (req.method !== 'GET') return sendJSON(res, { error: 'GET only' }, 405);
  const url = new URL(req.url, 'http://localhost');
  const key = viewerKey();
  if (!key) return sendJSON(res, { error: 'feedback viewer disabled (set AGENT_LOG_KEY)' }, 404);
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
  if (authThrottled(ip)) return sendJSON(res, { error: 'too many attempts — try again in an hour' }, 429);
  if (!keyMatches(url.searchParams.get('key'), key)) { noteBadKey(ip); return sendJSON(res, { error: 'unauthorized' }, 401); }
  if (!enabled()) return sendJSON(res, { error: 'feedback storage not configured' }, 503);

  try {
    if (url.searchParams.get('days') === '1') {
      const blobs = await listAll('feedback/'), days = new Set();
      for (const b of blobs) {
        const m = String(b.pathname || '').match(/^feedback\/(\d{4}-\d{2}-\d{2})\//);
        if (m) days.add(m[1]);
      }
      return sendJSON(res, { days: [...days].sort().reverse(), count: blobs.length });
    }
    const requested = url.searchParams.get('day') || '';
    const day = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : new Date().toISOString().slice(0, 10);
    const blobs = await listAll('feedback/' + day + '/');
    blobs.sort((a, b) => String(b.pathname).localeCompare(String(a.pathname)));
    const rows = await readAll(blobs);
    rows.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
    return sendJSON(res, { day, count: blobs.length, responses: rows });
  } catch (e) {
    return sendJSON(res, { error: String(e.message || e) }, 502);
  }
}

module.exports = { handleFeedbackView };
