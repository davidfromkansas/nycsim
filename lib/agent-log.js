/* ============================================================
   lib/agent-log.js — first-party usage logging for the City
   Concierge. One immutable Blob per conversation turn (race-free
   under Fluid Compute concurrency — never a read-modify-write),
   written straight to the Vercel Blob REST API with global fetch
   (no @vercel/blob SDK — the repo stays zero-dependency).

   Captures far more than the AI Gateway dashboard can: the user's
   message, the viewer/focus context, WHICH tools the model called
   with what arguments (the real signal for "how do people use
   this"), the intents produced (camera/layers/timeline), token
   usage, latency, rounds, and errors.

   Auth: BLOB_READ_WRITE_TOKEN — provisioned on the project when
   the `agent-logs` private store was connected (present in prod
   env; locally via `vercel env pull` → .env.local). If the token
   is absent, logging silently no-ops: usage capture must NEVER
   delay or break a user's reply, and missing config degrades
   gracefully like every other key in this codebase.
   NEVER log, commit, or echo the token itself.
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BLOB_BASE = 'https://blob.vercel-storage.com';
const API_VERSION = '7';           // verified against the private store
const WRITE_TIMEOUT_MS = 3500;     // bound the best-effort write; never hang a reply
const IP_SALT = 'manhattan-island-concierge-v1'; // stable per-deploy visitor grouping w/o storing raw IPs

function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    const m = env.match(/^BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?$/m);
    if (m) return m[1];
  } catch { /* no token: logging disabled */ }
  return null;
}
const enabled = () => !!blobToken();

const visitorHash = (ip) => crypto.createHash('sha256').update(IP_SALT + '|' + ip).digest('hex').slice(0, 12);

/* one blob per turn: agent-logs/YYYY-MM-DD/<epoch>-<rand>.json (lexicographic
   prefix listing = chronological; the random tail avoids collisions). */
function turnPath() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  return `agent-logs/${day}/${now.getTime()}-${crypto.randomBytes(4).toString('hex')}.json`;
}

async function putBlob(pathname, jsonStr) {
  const token = blobToken();
  if (!token) return false;
  const r = await fetch(BLOB_BASE + '/' + pathname, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer ' + token,
      'x-api-version': API_VERSION,
      'x-content-type': 'application/json',
      'x-add-random-suffix': '0',
      'x-vercel-blob-access': 'private'
    },
    body: jsonStr,
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS)
  });
  if (!r.ok) throw new Error('blob put http ' + r.status);
  return true;
}

/* Best-effort turn log. Awaited by the caller right before it responds, so
   the write completes on Fluid Compute (which may freeze the instance after
   the response) — but time-boxed and fully swallowed so it can neither slow
   nor break the reply. */
async function logTurn(event) {
  if (!enabled()) return false;
  try {
    await putBlob(turnPath(), JSON.stringify(event));
    return true;
  } catch (e) {
    console.error(new Date().toISOString(), '[agent-log] write failed:', e.message || e);
    return false;
  }
}

/* ---- read side (the /api/agent-log viewer) ---- */
async function listLogs(prefix, limit = 1000, cursor = null) {
  const token = blobToken();
  if (!token) throw new Error('logging not configured');
  const u = new URL(BLOB_BASE);
  u.searchParams.set('prefix', prefix || 'agent-logs/');
  u.searchParams.set('limit', String(Math.min(Math.max(1, limit), 1000)));
  if (cursor) u.searchParams.set('cursor', cursor);
  const r = await fetch(u, { headers: { authorization: 'Bearer ' + token, 'x-api-version': API_VERSION }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('blob list http ' + r.status);
  return await r.json(); // { blobs:[{url,pathname,size,uploadedAt}], cursor, hasMore }
}
async function readLog(downloadUrl) {
  const token = blobToken();
  if (!token) throw new Error('logging not configured');
  const r = await fetch(downloadUrl, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('blob get http ' + r.status);
  return await r.json();
}

module.exports = { logTurn, visitorHash, listLogs, readLog, enabled };
