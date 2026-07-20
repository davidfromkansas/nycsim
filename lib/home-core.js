/* ============================================================
   lib/home-core.js — "Home": sign in with Google, set your NYC
   address once, and the city opens at your block every visit.
   Zero dependencies; shared by server.js and api/home.js.

   ONE route (a real api/home.js beats the /api/(.*) rewrite for
   exactly /api/home, and nested paths would fall through to the
   cached-feed dispatcher — so no sub-paths):
     GET  /api/home                    → { enabled, clientId, signedIn, name, home }
     POST /api/home { action, ... }    → login | logout | set | confirm | delete

   Auth chain (all env → git-ignored JSON file, placesKey pattern):
     GOOGLE_CLIENT_ID  / google-oauth-client.json {"clientId"}   (public value)
     SESSION_SECRET    / session-secret.json      {"secret"}     (32+ random bytes)
     BLOB_READ_WRITE_TOKEN (already provisioned — agent-log store)
   Any of the three missing → { enabled:false } and the client keeps
   the legacy RESET button; nothing crashes (house standard).

   Privacy contract (plan-home.md): the street address is geocoded,
   confirmed, DISCARDED — never persisted. Coordinates are AES-256-GCM
   encrypted at rest, decrypted only for the authenticated owner.
   Email is stored plaintext by user decision (2026-07-14: feedback
   outreach) but must never appear in a response, log, or error.
   NEVER log, commit, or echo secrets or profile contents.
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sendJSON } = require('./api-core');
const { findPlace, whereIs, placesKey } = require('./agent-core');
const { appendSetCookie, linkVisitorToAccount, rotateVisitorCookie, deleteVisitorLinks } = require('./visitor-log');

/* ---------- config (env → git-ignored file → disabled) ---------- */
function fileVal(name, key) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'))[key] || null; }
  catch { return null; }
}
const clientId = () => process.env.GOOGLE_CLIENT_ID || fileVal('google-oauth-client.json', 'clientId');
const sessionSecret = () => process.env.SESSION_SECRET || fileVal('session-secret.json', 'secret');
function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const m = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
      .match(/^BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?$/m);
    if (m) return m[1];
  } catch { /* disabled */ }
  return null;
}
const enabled = () => !!(clientId() && sessionSecret() && blobToken());

/* ---------- session cookie: b64url({s:subHash, e:expMs}).hmac ---------- */
const COOKIE = 'mih';
const SESSION_DAYS = 30;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (s) => crypto.createHmac('sha256', sessionSecret()).update(s).digest('base64url');

function makeSession(subH) {
  const payload = b64u(JSON.stringify({ s: subH, e: Date.now() + SESSION_DAYS * 86_400_000 }));
  return payload + '.' + hmac(payload);
}
function readSession(req) {
  if (!sessionSecret()) return null;
  const m = /(?:^|;\s*)mih=([^;]+)/.exec(String(req.headers.cookie || ''));
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const want = hmac(payload);
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!j.s || !isFinite(j.e) || j.e < Date.now()) return null;
    return j.s;
  } catch { return null; }
}
function setCookie(req, res, value, maxAgeS) {
  const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  appendSetCookie(res, `${COOKIE}=${value}; Max-Age=${maxAgeS}; Path=/api/home; HttpOnly; SameSite=Lax${secure}`);
}

/* ---------- coords at rest: AES-256-GCM, key derived from the secret ---------- */
const encKey = () => crypto.createHash('sha256').update(sessionSecret() + '|home-loc-v1').digest();
function encLoc(lat, lon) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify({ lat, lon }), 'utf8'), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
}
function decLoc(enc) {
  try {
    const raw = Buffer.from(enc, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
}

/* ---------- profile blobs (agent-log.js REST pattern; overwrite allowed) ---------- */
const BLOB_BASE = 'https://blob.vercel-storage.com';
const API_VERSION = '7';
const subHash = (sub) => crypto.createHash('sha256').update('mih-v1|' + sub).digest('hex').slice(0, 32);
const profilePath = (subH) => `homes/${subH}.json`;
const profCache = new Map(); // subH → { t, profile|null } — softens the boot-time read
const PROF_TTL = 60_000;

async function blobFetch(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(6000),
    headers: { authorization: 'Bearer ' + blobToken(), 'x-api-version': API_VERSION, ...(opts && opts.headers) } });
  if (!r.ok) throw new Error('blob http ' + r.status);
  return r;
}
async function readProfile(subH, fresh = false) {
  const hit = profCache.get(subH);
  if (!fresh && hit && Date.now() - hit.t < PROF_TTL) return hit.profile;
  const u = new URL(BLOB_BASE);
  u.searchParams.set('prefix', profilePath(subH));
  u.searchParams.set('limit', '1');
  const list = await (await blobFetch(u)).json();
  const row = (list.blobs || [])[0];
  const profile = row ? await (await blobFetch(row.url)).json() : null;
  if (profile) profile._url = row.url; // for delete; stripped before any write
  profCache.set(subH, { t: Date.now(), profile });
  return profile;
}
async function writeProfile(subH, profile) {
  const { _url, ...clean } = profile;
  await blobFetch(BLOB_BASE + '/' + profilePath(subH), {
    method: 'PUT', body: JSON.stringify(clean),
    headers: { 'x-content-type': 'application/json', 'x-add-random-suffix': '0',
      'x-allow-overwrite': '1', 'x-vercel-blob-access': 'private' } });
  profCache.delete(subH);
}
async function deleteProfile(subH) {
  const p = await readProfile(subH).catch(() => null);
  if (p && p._url) await blobFetch(BLOB_BASE + '/delete', {
    method: 'POST', body: JSON.stringify({ urls: [p._url] }),
    headers: { 'content-type': 'application/json' } });
  profCache.delete(subH);
}

/* ---------- Google ID-token verify (tokeninfo: Google checks the signature;
   we assert audience/issuer/expiry/verified-email — login-only latency) ---------- */
async function verifyCredential(cred) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred),
    { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.aud !== clientId()) return null;
  if (j.iss !== 'accounts.google.com' && j.iss !== 'https://accounts.google.com') return null;
  if (Number(j.exp) * 1000 < Date.now()) return null;
  if (!j.sub || String(j.email_verified) !== 'true' || !j.email) return null;
  return { sub: j.sub, email: j.email, name: (j.given_name || j.name || 'Neighbor').slice(0, 40) };
}

/* ---------- per-IP rate limit (agent-core pattern, login/set only) ---------- */
const RL = new Map();
function rateLimited(ip) {
  const today = new Date().toISOString().slice(0, 10);
  let r = RL.get(ip);
  if (!r || r.day !== today) { r = { stamps: [], day: today, dayCount: 0 }; RL.set(ip, r); }
  const now = Date.now();
  r.stamps = r.stamps.filter(t => now - t < 60_000);
  if (r.stamps.length >= 10) return 'too many requests — wait a minute';
  if (++r.dayCount > 100) return 'daily limit reached for your connection';
  r.stamps.push(now);
  if (RL.size > 5000) RL.clear();
  return null;
}

function readBody(req) {
  if (req.body !== undefined) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 16_384) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/* owner-facing home view — decrypted coords + public-safe area labels.
   NEVER add email here (or to any other response shape). */
function homeView(profile) {
  if (!profile || !profile.enc) return null;
  const loc = decLoc(profile.enc);
  if (!loc) return null;
  return { lat: loc.lat, lon: loc.lon, borough: profile.boro || null, neighborhood: profile.nta || null };
}

const NYC = { latMin: 40.45, latMax: 41.05, lonMin: -74.35, lonMax: -73.55 }; // agent-core's box

/* ---------- per-IP rate limit for autocomplete keystrokes (separate from login/set) ---------- */
const AUTO_RL = new Map();
function autoRateLimited(ip) {
  const today = new Date().toISOString().slice(0, 10);
  let r = AUTO_RL.get(ip);
  if (!r || r.day !== today) { r = { stamps: [], day: today, dayCount: 0 }; AUTO_RL.set(ip, r); }
  const now = Date.now();
  r.stamps = r.stamps.filter(t => now - t < 60_000);
  if (r.stamps.length >= 30) return 'too many autocomplete requests — wait a minute';
  if (++r.dayCount > 500) return 'daily autocomplete limit reached for your connection';
  r.stamps.push(now);
  if (AUTO_RL.size > 5000) AUTO_RL.clear();
  return null;
}

/* ---------- Google Places Autocomplete (New) for the address input ---------- */
const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
async function autocomplete(input) {
  const q = String(input || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (q.length < 3) return { predictions: [] };
  const key = placesKey();
  if (!key) return { error: 'place search not configured' };
  try {
    const r = await fetch(PLACES_AUTOCOMPLETE_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(4000),
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'suggestions.placePrediction.place,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat' },
      body: JSON.stringify({
        input: q,
        includedRegionCodes: ['US'],
        locationBias: { rectangle: {
          low: { latitude: NYC.latMin, longitude: NYC.lonMin },
          high: { latitude: NYC.latMax, longitude: NYC.lonMax } } }
      })
    });
    if (!r.ok) return { error: 'autocomplete failed (' + r.status + ')' };
    const j = await r.json();
    const predictions = [];
    for (const s of (j.suggestions || []).slice(0, 5)) {
      const p = s.placePrediction;
      if (!p) continue;
      predictions.push({
        text: (p.text && p.text.text) || '',
        placeId: p.place || '',
        mainText: (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || '',
        secondaryText: (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || ''
      });
    }
    return { predictions };
  } catch { return { error: 'autocomplete unavailable right now' }; }
}

async function handleHome(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' }); return res.end(); }

  /* GET → boot-time state. Never cached (personal). */
  if (req.method !== 'POST') {
    if (!enabled()) return sendJSON(res, { enabled: false });
    const subH = readSession(req);
    if (!subH) return sendJSON(res, { enabled: true, clientId: clientId(), signedIn: false });
    let profile = null;
    const fresh = new URL(req.url || '/api/home', 'http://localhost').searchParams.get('fresh') === '1';
    try { profile = await readProfile(subH, fresh); }
    catch { if (fresh) return sendJSON(res, { error: 'saved home could not be refreshed' }, 502); }
    return sendJSON(res, { enabled: true, clientId: clientId(), signedIn: true,
      name: (profile && profile.name) || null, home: homeView(profile) });
  }

  if (!enabled()) return sendJSON(res, { error: 'home is not configured' }, 503);
  if (!/^application\/json/.test(String(req.headers['content-type'] || ''))) {
    return sendJSON(res, { error: 'JSON only' }, 400); // CSRF belt (SameSite=Lax is the braces)
  }
  let body;
  try { body = await readBody(req); } catch { return sendJSON(res, { error: 'bad request body' }, 400); }
  const action = String(body.action || '');
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();

  try {
    if (action === 'login') {
      const limited = rateLimited(ip);
      if (limited) return sendJSON(res, { error: limited }, 429);
      const who = await verifyCredential(String(body.credential || ''));
      if (!who) return sendJSON(res, { error: 'sign-in could not be verified' }, 401);
      const subH = subHash(who.sub);
      let profile = null;
      try { profile = await readProfile(subH); } catch { /* first write below still works */ }
      if (!profile) profile = { v: 1, sub_h: subH, prefs: {}, pub: false };
      profile.name = who.name;
      profile.email = who.email; // plaintext by user decision — private store only, never in a response
      profile.ts = Date.now();
      await writeProfile(subH, profile);
      setCookie(req, res, makeSession(subH), SESSION_DAYS * 86_400);
      try { await linkVisitorToAccount(req, res, subH); }
      catch (e) { console.error(new Date().toISOString(), '[home] visitor link failed:', e.message || e); } // analytics never breaks login
      return sendJSON(res, { ok: true, name: profile.name, home: homeView(profile) });
    }

    if (action === 'logout') {
      setCookie(req, res, 'x', 0);
      rotateVisitorCookie(req, res); // future logged-out activity is anonymous, not attached to this account
      return sendJSON(res, { ok: true });
    }

    if (action === 'autocomplete') {
      const limited = autoRateLimited(ip);
      if (limited) return sendJSON(res, { error: limited }, 429);
      return sendJSON(res, await autocomplete(String(body.input || '')));
    }

    /* everything below requires a session */
    const subH = readSession(req);
    if (!subH) return sendJSON(res, { error: 'sign in first' }, 401);

    if (action === 'set') { // address → candidate (NOTHING saved; address discarded after this reply)
      const limited = rateLimited(ip);
      if (limited) return sendJSON(res, { error: limited }, 429);
      const address = String(body.address || '').trim().slice(0, 120);
      if (address.length < 4) return sendJSON(res, { error: 'enter a street address' }, 400);
      const found = await findPlace({ query: address + (/(ny|new york)/i.test(address) ? '' : ', New York, NY') });
      if (found.error) return sendJSON(res, { error: found.error }, 502);
      const c = found.results[0];
      return sendJSON(res, { candidate: { address: c.address || c.name, lat: c.lat, lon: c.lon,
        borough: c.borough || null, neighborhood: c.neighborhood || null } });
    }

    if (action === 'confirm') { // client confirmed the candidate → save coords (encrypted) + area labels
      const lat = Number(body.lat), lon = Number(body.lon);
      if (!isFinite(lat) || !isFinite(lon) || lat < NYC.latMin || lat > NYC.latMax || lon < NYC.lonMin || lon > NYC.lonMax) {
        return sendJSON(res, { error: 'that point is outside NYC' }, 400);
      }
      const w = await whereIs({ lat, lon }).catch(() => ({}));
      const profile = (await readProfile(subH).catch(() => null)) || { v: 1, sub_h: subH, prefs: {}, pub: false };
      profile.enc = encLoc(+lat.toFixed(6), +lon.toFixed(6));
      profile.boro = w.borough || null;
      profile.nta = w.neighborhood || null;
      profile.ts = Date.now();
      await writeProfile(subH, profile);
      return sendJSON(res, { ok: true, home: homeView(profile) });
    }

    if (action === 'delete') { // account deletion: blob gone, cookie gone
      await deleteVisitorLinks(subH); // remove both link indexes; visit events remain anonymous aggregates
      await deleteProfile(subH);
      setCookie(req, res, 'x', 0);
      rotateVisitorCookie(req, res);
      return sendJSON(res, { ok: true });
    }

    return sendJSON(res, { error: 'unknown action' }, 400);
  } catch (e) {
    console.error(new Date().toISOString(), '[home]', action, 'failed:', e.message || e); // never profile contents
    return sendJSON(res, { error: 'home hit a snag — try again' }, 502);
  }
}

module.exports = { handleHome };
