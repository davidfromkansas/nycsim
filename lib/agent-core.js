/* ============================================================
   lib/agent-core.js — "City Concierge": a sandboxed LLM agent
   over the twin's own data. POST /api/agent {messages:[{role,
   content}...]} → {reply, camera|null}. Zero dependencies.

   Sandbox model: the LLM never touches the scene or the network
   directly. It gets READ-ONLY tools that reuse lib/api-core's
   cached routes in-process (same TTLs/last-good as the client),
   plus ONE write-shaped tool — set_camera — whose output is not
   executed here: it is validated, returned to the browser, and
   applied client-side through the existing camTween machinery.

   LLM transport: Vercel AI Gateway's Anthropic-compatible
   endpoint via raw fetch (no SDK — this repo stays zero-dep).
   Auth (first hit wins): AI_GATEWAY_API_KEY env · git-ignored
   ai-gateway-key.json {"key":"..."} · VERCEL_OIDC_TOKEN (auto
   on Vercel deployments; locally via `vercel env pull`).
   Missing key degrades gracefully: friendly 503, nothing crashes.
   NEVER log, commit, or echo key material.
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const { routes, handleApi, sendJSON } = require('./api-core');

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/messages';
const MODEL = 'anthropic/claude-sonnet-4.6';
const MAX_TOKENS = 800;      // per reply — bounds worst-case spend
const MAX_ROUNDS = 6;        // tool-use loop cap
const TOOL_RESULT_CAP = 7000; // chars per tool result fed back to the model

function gatewayKey(req) {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ai-gateway-key.json'), 'utf8'));
    if (j.key) return j.key;
  } catch { /* fall through */ }
  if (process.env.VERCEL_OIDC_TOKEN) return process.env.VERCEL_OIDC_TOKEN;
  // deployed Vercel functions receive the OIDC token per-request, not as an env var
  if (req && req.headers && req.headers['x-vercel-oidc-token']) return req.headers['x-vercel-oidc-token'];
  try { // local dev: `vercel env pull` drops VERCEL_OIDC_TOKEN into .env.local
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
    const m = env.match(/^VERCEL_OIDC_TOKEN="?([^"\n]+)"?$/m);
    if (m) return m[1];
  } catch { /* no key: degrade gracefully */ }
  return null;
}

/* ---------- in-process read of api-core's cached routes ----------
   Same freshness/last-good semantics as serveCached, minus the res. */
async function readFeed(routePath) {
  const entry = routes.get(routePath);
  if (!entry) throw new Error('unknown feed ' + routePath);
  const fresh = entry.data !== null && Date.now() - entry.fetchedAt < entry.ttl;
  if (!fresh) {
    if (!entry.refreshing) {
      entry.refreshing = entry.fetcher()
        .then(data => { entry.data = data; entry.fetchedAt = Date.now(); })
        .catch(e => console.error(new Date().toISOString(), '[agent] feed fetch failed:', e.message || e))
        .finally(() => { entry.refreshing = null; });
    }
    await entry.refreshing;
  }
  return entry.data ?? entry.empty;
}

/* ---------- feed compaction — keep tool results model-sized ----------
   Every compactor preserves the graph join keys (edgeId/street/nodeId/
   node) where the upstream payload has them — agent-ready per AGENTS.md. */
const hit = (s, f) => !f || String(s || '').toLowerCase().includes(f);
const takeN = (arr, limit, dflt, max) => arr.slice(0, Math.min(Math.max(1, limit || dflt), max));

async function stationNameMap() { // GTFS parent stop id ("R16") → station name
  const d = await readFeed('/api/subway/stations');
  const m = new Map();
  for (const r of d.rows || []) {
    const id = r.gtfs_stop_id || r.stop_id;
    if (id) m.set(String(id), r.stop_name || r.name || '');
  }
  return m;
}

const FEEDS = {
  async flights(f, limit) {
    const d = await readFeed('/api/flights');
    const rows = (d.ac || []).filter(a => hit(a.cs, f) || hit(a.hex, f) || hit(a.catLabel, f));
    return { source: d.source, airborneTotal: (d.ac || []).length, matched: rows.length,
      aircraft: takeN(rows, limit, 40, 80).map(a => ({ callsign: a.cs, hex: a.hex, lat: a.lat, lon: a.lon,
        altM: Math.round(a.altM), speedMs: Math.round(a.gsMs), track: Math.round(a.track), type: a.catLabel || undefined })) };
  },
  async weather() { const d = await readFeed('/api/weather'); return { source: d.source, current: d.current }; },
  async subway(f, limit) {
    const d = await readFeed('/api/subway');
    const names = await stationNameMap().catch(() => new Map());
    const byRoute = {}; const nowS = Date.now() / 1000;
    for (const t of d.trips || []) byRoute[t.route] = (byRoute[t.route] || 0) + 1;
    const out = { activeTrips: (d.trips || []).length, tripsByRoute: byRoute };
    if (f) {
      const rows = (d.trips || []).filter(t => t.route.toLowerCase() === f);
      out.matchedRoute = f.toUpperCase();
      out.trips = takeN(rows, limit, 15, 30).map(t => {
        const next = (t.stus || []).find(s => s[1] >= nowS - 30);
        return { tripId: t.tid, nextStop: next ? (names.get(next[0].replace(/[NS]$/, '')) || next[0]) : null,
          etaMin: next ? Math.max(0, Math.round((next[1] - nowS) / 60)) : null,
          stopped: d.vehStatus && d.vehStatus[t.tid] === 1 };
      });
    }
    return out;
  },
  async subway_stations(f, limit) {
    const d = await readFeed('/api/subway/stations');
    const rows = (d.rows || []).map(r => ({ name: r.stop_name || r.name || '', routes: r.daytime_routes || r.line || '',
      lat: parseFloat(r.gtfs_latitude ?? r.latitude), lon: parseFloat(r.gtfs_longitude ?? r.longitude), borough: r.borough || '' }))
      .filter(r => r.name && isFinite(r.lat) && (hit(r.name, f) || hit(r.routes, f)));
    return { totalStations: (d.rows || []).length, matched: rows.length, stations: takeN(rows, limit, 20, 50) };
  },
  async ferries(f, limit) {
    const d = await readFeed('/api/ferries');
    const rows = (d.vessels || []).filter(v => hit(v.label, f) || hit(v.route, f) || hit(v.headsign, f));
    return { vesselsTotal: (d.vessels || []).length, matched: rows.length,
      vessels: takeN(rows, limit, 30, 40).map(v => ({ name: v.label, route: v.route, headsign: v.headsign,
        lat: v.lat, lon: v.lon, speedMs: v.speedMs, nextStop: v.next, nextEtaMin: v.nextEtaMin, docked: v.docked })) };
  },
  async buses(f, limit) {
    const d = await readFeed('/api/buses');
    const byRoute = {};
    for (const b of d.buses || []) byRoute[b.route] = (byRoute[b.route] || 0) + 1;
    const rows = (d.buses || []).filter(b => hit(b.route, f) || hit(b.dest, f));
    return { busesTotal: (d.buses || []).length, busesByRoute: f ? undefined : byRoute, matched: rows.length,
      buses: takeN(rows, limit, 25, 60).map(b => ({ id: b.id, route: b.route, dest: b.dest,
        lat: b.lat, lon: b.lon, speedMs: b.speedMs })) };
  },
  async citibike(f, limit) {
    const d = await readFeed('/api/citibike');
    let bikes = 0, ebikes = 0, docks = 0;
    for (const s of d.stations || []) { bikes += s.bikes; ebikes += s.ebikes; docks += s.docks; }
    const rows = (d.stations || []).filter(s => hit(s.name, f));
    return { stationsTotal: (d.stations || []).length, citywide: { bikes, ebikes, docks }, matched: rows.length,
      stations: takeN(rows, limit, 20, 50).map(s => ({ name: s.name, lat: s.lat, lon: s.lon,
        bikes: s.bikes, ebikes: s.ebikes, docks: s.docks, active: s.on })) };
  },
  async cams(f, limit) {
    const d = await readFeed('/api/cams');
    const rows = (d.cams || []).filter(c => hit(c.name, f) || hit(c.area, f));
    return { camsTotal: (d.cams || []).length, matched: rows.length,
      cams: takeN(rows, limit, 20, 50).map(c => ({ name: c.name, area: c.area, lat: c.lat, lon: c.lon })) };
  },
  async traffic(f, limit) {
    const d = await readFeed('/api/traffic');
    const byBoro = {};
    for (const l of d.links || []) { (byBoro[l.borough] ||= { n: 0, sum: 0 }); byBoro[l.borough].n++; byBoro[l.borough].sum += l.speed; }
    const avg = Object.fromEntries(Object.entries(byBoro).map(([b, v]) => [b, Math.round(v.sum / v.n * 10) / 10]));
    const rows = (d.links || []).filter(l => hit(l.name, f) || hit(l.borough, f))
      .map(l => ({ id: l.id, name: l.name, borough: l.borough, speedMph: l.speed, travelTimeS: l.tt,
        lat: l.pts && l.pts.length ? l.pts[Math.floor(l.pts.length / 2)][0] : undefined,
        lon: l.pts && l.pts.length ? l.pts[Math.floor(l.pts.length / 2)][1] : undefined }));
    return { linksTotal: (d.links || []).length, avgSpeedMphByBorough: avg, matched: rows.length,
      links: takeN(rows, limit, 25, 60) };
  },
  async traffic_events(f, limit) {
    const d = await readFeed('/api/traffic-events');
    const rows = (d.events || []).filter(e => hit(e.road, f) || hit(e.desc, f) || hit(e.kind, f));
    return { eventsTotal: (d.events || []).length, matched: rows.length,
      events: takeN(rows, limit, 20, 40).map(e => ({ kind: e.kind, severity: e.sev, road: e.road,
        direction: e.dir, lat: e.lat, lon: e.lon, desc: e.desc })) };
  },
  async birds() { return await readFeed('/api/birds'); }
};

/* history: /api/history is special-cased inside handleApi (fetchHistory is
   not exported), so read it through handleApi with a stub res — keeps the
   GH token handling and day-file caching in exactly one place. */
function viaHandleApi(pathname) {
  return new Promise((resolve, reject) => {
    const res = { writeHead() {}, end(body) { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } } };
    handleApi(pathname, res).catch(reject);
  });
}
async function historyTool(input) {
  if (!input || !input.day) {
    const man = await viaHandleApi('/api/history');
    return { retentionDays: man.retentionDays, days: (man.daily || []).map(d => d.replace(/^daily\//, '').replace(/\.json$/, '')) };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) return { error: 'day must be YYYY-MM-DD' };
  const fr = await viaHandleApi('/api/history/' + input.day);
  if (fr.error) return fr;
  const out = { day: input.day, recordedAt: fr.t, weather: fr.weather, counts: {
    buses: (fr.buses || []).length, bikeStations: (fr.bikes || []).length, ferries: (fr.ferries || []).length,
    flights: (fr.flights || []).length, subwayTrips: fr.subway ? (fr.subway.trips || []).length : 0,
    trafficLinks: (fr.traffic || []).length, trafficEvents: (fr.trafficEvents || []).length }, schema: fr.schema };
  const feed = input.feed;
  if (feed && fr[feed]) out.rows = fr[feed].slice(0, 30); // schema field names the columns
  return out;
}

/* ---------- tools ---------- */
const NYC = { latMin: 40.45, latMax: 41.05, lonMin: -74.35, lonMax: -73.55 };
const PRESETS = ['hero', 'downtown', 'canyon', 'park', 'bridges', 'gwb'];
const TOOLS = [
  { name: 'get_data',
    description: 'Read a live data feed from the NYC digital twin. Optional case-insensitive substring filter (matches names/routes/callsigns/areas; for feed=subway the filter is an exact route letter/number like "A" or "7").',
    input_schema: { type: 'object', properties: {
      feed: { type: 'string', enum: Object.keys(FEEDS) },
      filter: { type: 'string' }, limit: { type: 'integer' } }, required: ['feed'] } },
  { name: 'get_history',
    description: 'Recorded daily snapshots (last ~7 days, one frame per day at ~05:05 UTC). No args → list of available days. With day (YYYY-MM-DD) → that snapshot\'s weather + counts; add feed (buses|bikes|ferries|flights|traffic|trafficEvents) for sample rows (see returned schema for column order).',
    input_schema: { type: 'object', properties: { day: { type: 'string' }, feed: { type: 'string' } } } },
  { name: 'set_camera',
    description: 'Fly the user\'s 3D camera. Use preset when one fits, otherwise lat/lon of the place to look at (use your NYC geographic knowledge). altitude_m: ~250 street-level, ~500 landmark, ~1200 neighborhood, 4000+ borough-wide. heading_deg: compass bearing the camera looks TOWARD (Manhattan\'s avenues run ~29°E of true north, so 20–30 reads naturally up the island). Call at most once per user request, as your final tool call.',
    input_schema: { type: 'object', properties: {
      preset: { type: 'string', enum: PRESETS, description: 'hero=full island, downtown=harbor, canyon=midtown, park=Central Park, bridges=East River, gwb=George Washington Bridge' },
      lat: { type: 'number' }, lon: { type: 'number' },
      altitude_m: { type: 'number' }, heading_deg: { type: 'number' },
      duration_s: { type: 'number' }, label: { type: 'string', description: 'short place name shown to the user' } } } }
];

function validCamera(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.preset && PRESETS.includes(c.preset)) return { preset: c.preset, label: c.label || c.preset };
  const lat = Number(c.lat), lon = Number(c.lon);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat < NYC.latMin || lat > NYC.latMax || lon < NYC.lonMin || lon > NYC.lonMax) return null;
  const cl = (v, a, b, d) => { v = Number(v); return isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  return { lat, lon, altitude_m: cl(c.altitude_m, 80, 16000, 600),
    heading_deg: ((cl(c.heading_deg, -360, 720, 25) % 360) + 360) % 360,
    duration_s: cl(c.duration_s, 1, 6, 2.6), label: String(c.label || '').slice(0, 60) };
}

const SYSTEM = `You are the City Concierge inside a live Three.js digital twin of New York City. \
The scene covers Manhattan (fully built), the Brooklyn/LIC/Astoria waterfront, the South Bronx, \
Roosevelt and Governors Islands, and LGA + JFK airports, with LIVE feeds: aircraft, subway trips, \
NYC Ferry vessels, MTA buses, Citi Bike stations, DOT traffic speeds/cameras/incidents, weather, \
and BirdCast bird migration, plus daily snapshots of the past week.
Rules:
- Answer questions about the city ONLY from tool results — call get_data first, never invent numbers.
- When the user asks to see, zoom, fly to, or look at anything, call set_camera. Prefer a preset when \
one matches; otherwise supply lat/lon from your NYC knowledge. For a moving thing (a ferry, a plane), \
read its live position first and aim there.
- Keep replies under ~60 words of plain conversational text. NO markdown of any kind — no asterisks, \
no bullets, no headings (the chat UI renders raw text). Mention what the user will see when you move \
the camera.
- The twin is a stylized model: Manhattan's buildings and bridges are real, but individual monuments \
(e.g. the Statue of Liberty) are not modeled — describe what the scene actually shows, don't promise \
photorealism.
- You cannot change anything except the camera. Politely decline anything else (weather, time scrub, \
simulation settings are read-only to you).`;

/* ---------- per-IP rate limiting (per warm instance — bounds burst abuse;
   Fluid Compute keeps instances warm so this holds up in practice) ---------- */
const RL = new Map(); // ip → { stamps: [ms...], day: 'YYYY-MM-DD', dayCount }
let instanceDay = '', instanceCount = 0;
const RL_PER_MIN = 8, RL_PER_DAY = 60, RL_INSTANCE_PER_DAY = 500;
function rateLimited(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (instanceDay !== today) { instanceDay = today; instanceCount = 0; }
  if (++instanceCount > RL_INSTANCE_PER_DAY) return 'global daily budget reached — try tomorrow';
  let r = RL.get(ip);
  if (!r || r.day !== today) { r = { stamps: [], day: today, dayCount: 0 }; RL.set(ip, r); }
  const now = Date.now();
  r.stamps = r.stamps.filter(t => now - t < 60_000);
  if (r.stamps.length >= RL_PER_MIN) return 'too many messages — wait a minute';
  if (++r.dayCount > RL_PER_DAY) return 'daily limit reached for your connection';
  r.stamps.push(now);
  if (RL.size > 5000) RL.clear();
  return null;
}

/* ---------- gateway call ---------- */
async function callGateway(key, messages) {
  const r = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, tools: TOOLS, messages }),
    signal: AbortSignal.timeout(45_000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('gateway http ' + r.status + ' ' + JSON.stringify(j.error || j).slice(0, 200));
  return j;
}

async function runTool(name, input) {
  try {
    if (name === 'get_data') {
      const fn = FEEDS[input && input.feed];
      if (!fn) return { error: 'unknown feed' };
      return await fn(input.filter ? String(input.filter).toLowerCase() : '', input.limit);
    }
    if (name === 'get_history') return await historyTool(input || {});
    return { error: 'unknown tool' };
  } catch (e) { return { error: String(e.message || e) }; }
}

/* ---------- request handler (shared by server.js and api/agent.js) ---------- */
function readBody(req) {
  if (req.body !== undefined) { // Vercel pre-parses JSON bodies
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 65_536) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handleAgent(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST' }); return res.end(); }
  const key = gatewayKey(req);
  if (req.method !== 'POST') return sendJSON(res, { ok: true, llm: !!key, model: MODEL });
  if (!key) return sendJSON(res, { error: 'agent not configured (no AI Gateway credential)' }, 503);

  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
  const limited = rateLimited(ip);
  if (limited) return sendJSON(res, { error: limited }, 429);

  let body;
  try { body = await readBody(req); } catch { return sendJSON(res, { error: 'bad request body' }, 400); }
  const msgs = Array.isArray(body && body.messages) ? body.messages.slice(-16) : null;
  if (!msgs || !msgs.length) return sendJSON(res, { error: 'messages required' }, 400);
  const messages = [];
  for (const m of msgs) { // sanitize: plain user/assistant text turns only
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return sendJSON(res, { error: 'bad message shape' }, 400);
    const prev = messages[messages.length - 1];
    if (prev && prev.role === m.role) prev.content = (prev.content + '\n' + m.content).slice(0, 4000); // API rejects consecutive same-role turns
    else messages.push({ role: m.role, content: m.content.slice(0, 2000) });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (messages[messages.length - 1].role !== 'user') return sendJSON(res, { error: 'last message must be user' }, 400);

  try {
    let camera = null, reply = '';
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const resp = await callGateway(key, messages);
      const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
      for (const b of resp.content || []) if (b.type === 'text') reply = b.text;
      if (resp.stop_reason !== 'tool_use' || !toolUses.length) break;
      messages.push({ role: 'assistant', content: resp.content });
      const results = [];
      for (const tu of toolUses) {
        let out;
        if (tu.name === 'set_camera') {
          camera = validCamera(tu.input);
          out = camera ? { ok: true, applied: camera } : { error: 'invalid or out-of-bounds camera target (NYC area only)' };
        } else {
          out = await runTool(tu.name, tu.input);
        }
        let s = JSON.stringify(out);
        if (s.length > TOOL_RESULT_CAP) s = s.slice(0, TOOL_RESULT_CAP) + '…(truncated — use a filter or smaller limit)';
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: s });
      }
      messages.push({ role: 'user', content: results });
    }
    if (!reply) reply = camera ? 'On our way.' : 'Sorry — I could not put an answer together.';
    return sendJSON(res, { reply, camera });
  } catch (e) {
    console.error('[agent]', e.message || e);
    return sendJSON(res, { error: 'agent error: ' + String(e.message || e).slice(0, 140) }, 502);
  }
}

module.exports = { handleAgent };
