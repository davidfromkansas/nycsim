/* Private, zero-dependency feedback capture for POST /api/feedback.
   Each submission is an immutable JSON blob under feedback/YYYY-MM-DD/.
   Email is optional and stored only when the visitor supplies it. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sendJSON } = require('./api-core');

const BLOB_BASE = 'https://blob.vercel-storage.com';
const API_VERSION = '7';
const attempts = new Map();

function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    const m = env.match(/^BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?$/m);
    return m ? m[1] : null;
  } catch { return null; }
}
function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim() || 'unknown';
}
function rateLimited(ip) {
  const now = Date.now(), hourAgo = now - 3600000;
  const recent = (attempts.get(ip) || []).filter(t => t > hourAgo);
  if (recent.length >= 5) { attempts.set(ip, recent); return true; }
  recent.push(now); attempts.set(ip, recent); return false;
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8192) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}
function cleanMessage(value) {
  return String(value || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}
function deviceClass(ua) {
  ua = String(ua || '');
  if (/ipad|tablet|kindle|silk/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android/i.test(ua)) return 'mobile';
  return 'desktop';
}
function feedbackPath(ts) {
  const day = new Date(ts).toISOString().slice(0, 10);
  return `feedback/${day}/${ts}-${crypto.randomBytes(4).toString('hex')}.json`;
}
async function writeFeedback(event) {
  const token = blobToken();
  if (!token) throw new Error('feedback storage not configured');
  const r = await fetch(BLOB_BASE + '/' + feedbackPath(event.ts), {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + token, 'x-api-version': API_VERSION,
      'x-content-type': 'application/json', 'x-add-random-suffix': '0', 'x-vercel-blob-access': 'private' },
    body: JSON.stringify(event), signal: AbortSignal.timeout(5000)
  });
  if (!r.ok) throw new Error('blob put http ' + r.status);
}

async function listFeedback(prefix, limit = 1000, cursor = null) {
  const token = blobToken();
  if (!token) throw new Error('feedback storage not configured');
  const u = new URL(BLOB_BASE);
  u.searchParams.set('prefix', prefix || 'feedback/');
  u.searchParams.set('limit', String(Math.min(Math.max(1, limit), 1000)));
  if (cursor) u.searchParams.set('cursor', cursor);
  const r = await fetch(u, { headers: { authorization: 'Bearer ' + token, 'x-api-version': API_VERSION },
    signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('blob list http ' + r.status);
  return await r.json();
}
async function readFeedback(downloadUrl) {
  const token = blobToken();
  if (!token) throw new Error('feedback storage not configured');
  const r = await fetch(downloadUrl, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('blob get http ' + r.status);
  return await r.json();
}

async function handleFeedback(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST' });
    return res.end();
  }
  if (req.method !== 'POST') return sendJSON(res, { error: 'POST only' }, 405);
  if (!blobToken()) return sendJSON(res, { error: 'feedback is temporarily unavailable' }, 503);
  if (!/^application\/json/.test(String(req.headers['content-type'] || ''))) return sendJSON(res, { error: 'JSON only' }, 400);
  if (rateLimited(requestIp(req))) return sendJSON(res, { error: 'too many submissions — try again later' }, 429);
  try {
    const body = await readBody(req);
    if (body.company) return sendJSON(res, { ok: true }); // honeypot: quietly accept bots without storing
    const message = cleanMessage(body.message);
    const email = String(body.email || '').trim().toLowerCase();
    if (!message) return sendJSON(res, { error: 'write a message first' }, 400);
    if (message.length > 2000) return sendJSON(res, { error: 'message is too long' }, 400);
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return sendJSON(res, { error: 'enter a valid email or leave it blank' }, 400);
    }
    const event = { v: 1, ts: Date.now(), message, email: email || null,
      source: String(body.source || '').slice(0, 40) || 'feedback-form', device: deviceClass(req.headers['user-agent']) };
    await writeFeedback(event);
    return sendJSON(res, { ok: true });
  } catch (e) {
    console.error(new Date().toISOString(), '[feedback] write failed:', e.message || e); // never log submitted content
    return sendJSON(res, { error: 'could not send feedback — please try again' }, 502);
  }
}

module.exports = { handleFeedback, listFeedback, readFeedback, enabled: () => !!blobToken() };
