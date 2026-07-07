/* GET /api/agent-log — private viewer over the recorded Concierge turns.
   Gated by the AGENT_LOG_KEY env var (?key=… must match). Disabled with a
   404 when the key is unset, so the endpoint is inert until you opt in.
   The underlying Blob store is PRIVATE — data is only ever read back
   through this authenticated function, never a public URL.

   ?key=<AGENT_LOG_KEY>            required
   ?day=YYYY-MM-DD                 list that day (default: today)
   ?limit=N                        cap rows (default 200, max 1000)
   ?full=1                         inline each turn's JSON (else metadata only)
   ?stats=1                        aggregate the day instead of listing:
                                   turn count, unique visitors, tool-call
                                   histogram, error rate, token totals. */
const fs = require('node:fs');
const path = require('node:path');
const { listLogs, readLog, enabled } = require('./agent-log');
const { sendJSON } = require('./api-core');

function viewerKey() { // env in prod; git-ignored .env.local for local dev (matches gatewayKey/blobToken)
  if (process.env.AGENT_LOG_KEY) return process.env.AGENT_LOG_KEY;
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    const m = env.match(/^AGENT_LOG_KEY="?([^"\n]+)"?$/m);
    if (m) return m[1];
  } catch { /* unset → viewer disabled */ }
  return null;
}

async function handleAgentLog(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const key = viewerKey();
  if (!key) return sendJSON(res, { error: 'log viewer disabled (set AGENT_LOG_KEY)' }, 404);
  if (url.searchParams.get('key') !== key) return sendJSON(res, { error: 'unauthorized' }, 401);
  if (!enabled()) return sendJSON(res, { error: 'blob logging not configured' }, 503);

  const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '')
    ? url.searchParams.get('day') : new Date().toISOString().slice(0, 10);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 200), 1000);
  const full = url.searchParams.get('full') === '1';
  const stats = url.searchParams.get('stats') === '1';

  try {
    const prefix = 'agent-logs/' + day + '/';
    let cursor = null, blobs = [];
    do {
      const page = await listLogs(prefix, 1000, cursor);
      blobs = blobs.concat(page.blobs || []);
      cursor = page.hasMore ? page.cursor : null;
    } while (cursor && blobs.length < 4000);
    blobs.sort((a, b) => a.pathname.localeCompare(b.pathname)); // chronological (epoch prefix)

    if (stats) {
      const rows = await Promise.all(blobs.slice(-limit).map(b => readLog(b.downloadUrl || b.url).catch(() => null)));
      const S = { day, turns: 0, visitors: new Set(), toolCalls: {}, statuses: {}, layers: 0, cameras: 0, scrubs: 0,
        input_tokens: 0, output_tokens: 0, latency_ms_p50: 0 };
      const lat = [];
      for (const r of rows) {
        if (!r) continue;
        S.turns++;
        if (r.visitor) S.visitors.add(r.visitor);
        S.statuses[r.status] = (S.statuses[r.status] || 0) + 1;
        for (const t of r.tools || []) S.toolCalls[t.name] = (S.toolCalls[t.name] || 0) + 1;
        if (r.intents) { if (r.intents.camera) S.cameras++; S.layers += (r.intents.layers || []).length; if (r.intents.timeline != null) S.scrubs++; }
        if (r.usage) { S.input_tokens += r.usage.input_tokens || 0; S.output_tokens += r.usage.output_tokens || 0; }
        if (typeof r.latency_ms === 'number') lat.push(r.latency_ms);
      }
      lat.sort((a, b) => a - b);
      S.latency_ms_p50 = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
      return sendJSON(res, { ...S, visitors: S.visitors.size });
    }

    const page = blobs.slice(-limit);
    if (!full) return sendJSON(res, { day, count: blobs.length,
      turns: page.map(b => ({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt })) });
    const turns = await Promise.all(page.map(b => readLog(b.downloadUrl || b.url).catch(() => ({ error: 'unreadable', pathname: b.pathname }))));
    return sendJSON(res, { day, count: blobs.length, returned: turns.length, turns });
  } catch (e) {
    return sendJSON(res, { error: String(e.message || e) }, 502);
  }
}

module.exports = { handleAgentLog };
