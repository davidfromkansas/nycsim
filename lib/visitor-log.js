/* ============================================================
   lib/visitor-log.js — first-party, pseudonymous return visits.

   POST /api/visit sets a 90-day HttpOnly cookie and writes one
   immutable event per browser session to the existing private
   Vercel Blob store. The random cookie value is NEVER persisted:
   logs carry only an HMAC-SHA256 digest keyed by SESSION_SECRET
   (or VISITOR_SECRET when configured). No raw IP, email, address,
   exact coordinates, or full referrer URL is collected.
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sendJSON } = require('./api-core');

const BLOB_BASE = 'https://blob.vercel-storage.com';
const API_VERSION = '7';
const COOKIE = 'nycsim_vid';
const COOKIE_DAYS = 90;
const COOKIE_MAX_AGE = COOKIE_DAYS * 86_400;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/; // randomBytes(16).toString('base64url')

function fileVal(name, key) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'))[key] || null; }
  catch { return null; }
}
function envLocal(name) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    const m = env.match(new RegExp('^' + name + '="?([^"\\n]+)"?$', 'm'));
    return m ? m[1] : null;
  } catch { return null; }
}
const blobToken = () => process.env.BLOB_READ_WRITE_TOKEN || envLocal('BLOB_READ_WRITE_TOKEN');
const visitorSecret = () => process.env.VISITOR_SECRET || process.env.SESSION_SECRET
  || fileVal('session-secret.json', 'secret') || envLocal('SESSION_SECRET');
const enabled = () => !!(blobToken() && visitorSecret());

function cookieToken(req) {
  const m = /(?:^|;\s*)nycsim_vid=([^;]+)/.exec(String(req.headers.cookie || ''));
  return m && TOKEN_RE.test(m[1]) ? m[1] : null;
}
function appendSetCookie(res, value) {
  const prior = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : null;
  const values = prior == null ? [] : Array.isArray(prior) ? prior : [prior];
  res.setHeader('Set-Cookie', values.concat(value));
}
function setCookie(req, res, token) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  appendSetCookie(res, `${COOKIE}=${token}; Max-Age=${COOKIE_MAX_AGE}; Path=/api; HttpOnly; SameSite=Lax${secure}`);
}
function visitorHash(token) {
  return crypto.createHmac('sha256', visitorSecret()).update('nycsim-visit-v1|' + token).digest('hex').slice(0, 24);
}
function clean(value, max = 80) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) || null;
}
function referrerHost(value) {
  try { return clean(new URL(String(value || '')).hostname.toLowerCase(), 120); }
  catch { return null; }
}
function deviceClass(ua) {
  ua = String(ua || '');
  if (/ipad|tablet|kindle|silk/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android/i.test(ua)) return 'mobile';
  return 'desktop';
}
function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
}
function ignoredRequest(req) {
  const ua = String(req.headers['user-agent'] || '');
  if (/bot|crawler|spider|slurp|headless|lighthouse|pagespeed|monitoring/i.test(ua)) return 'bot';
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') return 'non-production';
  const internal = String(process.env.ANALYTICS_INTERNAL_IPS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (internal.includes(requestIp(req))) return 'internal';
  return null;
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}
function visitPath(now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return `visitor-logs/${day}/${now}-${crypto.randomBytes(4).toString('hex')}.json`;
}
async function putVisit(event) {
  const r = await fetch(BLOB_BASE + '/' + visitPath(event.ts), {
    method: 'PUT',
    headers: {
      authorization: 'Bearer ' + blobToken(),
      'x-api-version': API_VERSION,
      'x-content-type': 'application/json',
      'x-add-random-suffix': '0',
      'x-vercel-blob-access': 'private'
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(3000)
  });
  if (!r.ok) throw new Error('blob put http ' + r.status);
}

/* ---------- visitor ↔ signed-in account links ----------
   Dual indexes make reports cheap by visitor and make account deletion complete.
   Values contain opaque hashes only; email/name stay solely in homes/<sub_h>.json. */
const byVisitorPath = (visitor) => `visitor-links/by-visitor/${visitor}.json`;
const byUserPath = (subH, visitor) => `visitor-links/by-user/${subH}/${visitor}.json`;
async function putPrivate(pathname, value) {
  const r = await fetch(BLOB_BASE + '/' + pathname, {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + blobToken(), 'x-api-version': API_VERSION,
      'x-content-type': 'application/json', 'x-add-random-suffix': '0', 'x-allow-overwrite': '1',
      'x-vercel-blob-access': 'private' },
    body: JSON.stringify(value), signal: AbortSignal.timeout(4000)
  });
  if (!r.ok) throw new Error('blob link put http ' + r.status);
}
async function deleteUrls(urls) {
  if (!urls.length) return;
  const r = await fetch(BLOB_BASE + '/delete', { method: 'POST',
    headers: { authorization: 'Bearer ' + blobToken(), 'x-api-version': API_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ urls }), signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('blob link delete http ' + r.status);
}
async function listAll(prefix, cap = 100_000) {
  let cursor = null, blobs = [];
  do {
    const page = await listVisitLogs(prefix, 1000, cursor);
    blobs.push(...(page.blobs || []));
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor && blobs.length < cap);
  return blobs;
}
async function exactLink(pathname) {
  const rows = await listAll(pathname, 2);
  const row = rows.find(r => r.pathname === pathname) || null;
  if (!row) return null;
  const value = await readVisit(row.downloadUrl || row.url);
  return { row, value };
}
async function putVisitorLink(visitor, subH) {
  const existing = await exactLink(byVisitorPath(visitor)).catch(() => null);
  if (existing && existing.value.user && existing.value.user !== subH) {
    const oldReverse = await exactLink(byUserPath(existing.value.user, visitor)).catch(() => null);
    if (oldReverse) await deleteUrls([oldReverse.row.url]);
  }
  const value = { v: 1, visitor, user: subH, linkedAt: Date.now() };
  // Reverse first: if the second write fails, account deletion can still discover
  // and clean the partial link. A direct link is never created without its reverse.
  await putPrivate(byUserPath(subH, visitor), value);
  await putPrivate(byVisitorPath(visitor), value);
}
async function linkVisitorToAccount(req, res, subH) {
  if (!enabled() || !/^[a-f0-9]{32}$/.test(String(subH || ''))) return [];
  const prior = cookieToken(req);
  if (!prior) return []; // preserves GPC/DNT visitors for whom no analytics cookie exists
  const oldVisitor = visitorHash(prior);
  const next = crypto.randomBytes(16).toString('base64url'), newVisitor = visitorHash(next);
  await putVisitorLink(oldVisitor, subH);     // retrospectively identifies earlier anonymous events
  await putVisitorLink(newVisitor, subH);    // owns subsequent signed-in visits after rotation
  setCookie(req, res, next);
  return [oldVisitor, newVisitor];
}
function rotateVisitorCookie(req, res) {
  if (!visitorSecret() || !cookieToken(req)) return false;
  setCookie(req, res, crypto.randomBytes(16).toString('base64url'));
  return true;
}
async function deleteVisitorLinks(subH) {
  if (!enabled() || !/^[a-f0-9]{32}$/.test(String(subH || ''))) return false;
  const reverse = await listAll(`visitor-links/by-user/${subH}/`);
  const urls = reverse.map(r => r.url);
  for (const r of reverse) {
    const visitor = String(r.pathname || '').split('/').pop().replace(/\.json$/, '');
    const direct = await exactLink(byVisitorPath(visitor)).catch(() => null);
    if (direct && direct.value.user === subH) urls.push(direct.row.url);
  }
  for (let i = 0; i < urls.length; i += 100) await deleteUrls(urls.slice(i, i + 100));
  return true;
}
async function listVisitorLinks() { return await listAll('visitor-links/by-visitor/'); }
async function readVisitorLink(row) { return await readVisit(row.downloadUrl || row.url); }

async function handleVisit(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST' }); return res.end(); }
  if (req.method !== 'POST') return sendJSON(res, { error: 'POST only' }, 405);
  if (!enabled()) return sendJSON(res, { enabled: false }, 503);
  if (!/^application\/json/.test(String(req.headers['content-type'] || ''))) return sendJSON(res, { error: 'JSON only' }, 400);
  const ignored = ignoredRequest(req);
  if (ignored) return sendJSON(res, { ok: true, ignored }); // no event and no analytics cookie

  try {
    const body = await readBody(req);
    const prior = cookieToken(req);
    const token = prior || crypto.randomBytes(16).toString('base64url');
    const now = Date.now();
    const event = {
      v: 1,
      ts: now,
      visitor: visitorHash(token),
      returning: !!prior,
      page: clean(body.page, 160) || '/',
      referrer: referrerHost(body.referrer),
      utm_source: clean(body.utm_source),
      utm_medium: clean(body.utm_medium),
      utm_campaign: clean(body.utm_campaign),
      country: clean(req.headers['x-vercel-ip-country'], 8),
      region: clean(req.headers['x-vercel-ip-country-region'], 32),
      device: deviceClass(req.headers['user-agent'])
    };
    await putVisit(event);
    if (!prior) setCookie(req, res, token); // do not mint an unrecorded identity if storage failed
    return sendJSON(res, { ok: true, returning: event.returning });
  } catch (e) {
    console.error(new Date().toISOString(), '[visitor-log] write failed:', e.message || e);
    return sendJSON(res, { error: 'visit could not be recorded' }, 502);
  }
}

async function listVisitLogs(prefix, limit = 1000, cursor = null) {
  const u = new URL(BLOB_BASE);
  u.searchParams.set('prefix', prefix);
  u.searchParams.set('limit', String(Math.min(Math.max(1, limit), 1000)));
  if (cursor) u.searchParams.set('cursor', cursor);
  const r = await fetch(u, { headers: { authorization: 'Bearer ' + blobToken(), 'x-api-version': API_VERSION }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('blob list http ' + r.status);
  return await r.json();
}
async function readVisit(downloadUrl) {
  const r = await fetch(downloadUrl, { headers: { authorization: 'Bearer ' + blobToken() }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('blob get http ' + r.status);
  return await r.json();
}

module.exports = { handleVisit, listVisitLogs, readVisit, listVisitorLinks, readVisitorLink, enabled, COOKIE_DAYS,
  appendSetCookie, linkVisitorToAccount, rotateVisitorCookie, deleteVisitorLinks, ignoredRequest };
