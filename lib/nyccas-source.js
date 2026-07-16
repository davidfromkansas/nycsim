const { createHash } = require('node:crypto');

const ROOT = 'https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/';
const STATIONS_URL = ROOT + 'portal/station-new.csv';
const PORTAL_URL = ROOT + 'portal/view.csv';
const MAX_BYTES = 5_000_000;
const previousHashes = new Map();
const previousStates = new Map();
let previousLagState = '';

function csvObjects(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field.trim()); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field.trim()); if (row.some(Boolean)) rows.push(row); }
  if (!rows.length) return [];
  const head = rows.shift().map((x, i) => i === 0 ? x.replace(/^\uFEFF/, '') : x);
  return rows.map(values => Object.fromEntries(head.map((key, i) => [key, values[i] ?? ''])));
}

function parseTimestamp(value, offsetHours = 0) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + offsetHours, +m[5], +m[6]) : NaN;
}

const easternParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function parseEasternTimestamp(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const localAsUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const offsetAt = utcMs => {
    const parts = Object.fromEntries(easternParts.formatToParts(utcMs).filter(part => part.type !== 'literal').map(part => [part.type, +part.value]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs;
  };
  let result = localAsUtc - offsetAt(localAsUtc);
  result = localAsUtc - offsetAt(result);
  return result;
}

function archiveUrls(nowMs = Date.now()) {
  const current = new Date(nowMs), previous = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
  const url = d => ROOT + 'hist/csv/' + d.getUTCFullYear() + '/' + (d.getUTCMonth() + 1) + '.csv';
  return [url(current), url(previous)];
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseStations(text) {
  const rows = csvObjects(text);
  if (!rows.length || !Object.hasOwn(rows[0], 'SiteID') || !Object.hasOwn(rows[0], 'loc_col')) throw new Error('schema');
  const byId = new Map(), byName = new Map();
  for (const row of rows) {
    const id = String(row.SiteID || '').trim(), lat = +row.Latitude, lon = +row.Longitude;
    if (!id || !isFinite(lat) || !isFinite(lon) || lat < 40.45 || lat > 41.05 || lon < -74.35 || lon > -73.55) continue;
    const item = { id, name: String(row.Location || row.loc_col).slice(0, 60), lat, lon };
    byId.set(id, item); byName.set(normalizeName(row.loc_col || row.Location), item);
  }
  if (!byId.size) throw new Error('empty');
  return { byId, byName };
}

function validObservation(meta, value, observedAt, nowMs, source, sourceRowId = null) {
  if (!meta || !isFinite(value) || value < 0 || value > 1000 || !isFinite(observedAt) || observedAt > nowMs + 15 * 60_000) return null;
  return { siteId: meta.id, name: meta.name, lat: meta.lat, lon: meta.lon, value, observedAt, source, sourceRowId };
}

function parsePortal(text, stations, nowMs = Date.now()) {
  const rows = csvObjects(text);
  if (!rows.length || !Object.hasOwn(rows[0], 'SiteName') || !Object.hasOwn(rows[0], 'starttime') || !Object.hasOwn(rows[0], 'Value')) throw new Error('schema');
  const observations = [];
  for (const row of rows) {
    const item = validObservation(stations.byName.get(normalizeName(row.SiteName)), +row.Value, parseEasternTimestamp(row.starttime), nowMs, 'portal');
    if (item) observations.push(item);
  }
  if (!observations.length) throw new Error('empty');
  return observations;
}

function parseArchive(text, stations, nowMs = Date.now()) {
  const rows = csvObjects(text);
  if (!rows.length || !Object.hasOwn(rows[0], 'SiteID') || !Object.hasOwn(rows[0], 'ObservationTimeUTC') || !Object.hasOwn(rows[0], 'Value')) throw new Error('schema');
  const observations = [];
  for (const row of rows) {
    const item = validObservation(stations.byId.get(String(row.SiteID || '').trim()), +row.Value, parseTimestamp(row.ObservationTimeUTC), nowMs, 'archive', String(row.ID || '') || null);
    if (item) observations.push(item);
  }
  if (!observations.length) throw new Error('empty');
  return observations;
}

function errorCode(error) {
  if (error && error.name === 'TimeoutError') return 'timeout';
  const message = String(error && error.message || error || 'failed');
  if (/^http_\d+$/.test(message) || ['schema', 'empty', 'oversize', 'html', 'lfs'].includes(message)) return message;
  return 'failed';
}

async function fetchCsv(url, sourceName, fetchImpl = fetch, nowMs = Date.now()) {
  const separator = url.includes('?') ? '&' : '?', requestUrl = url + separator + 'fresh=' + Math.floor(nowMs / 60_000);
  const response = await fetchImpl(requestUrl, { headers: { 'User-Agent': 'manhattan-island-city-twin', 'Cache-Control': 'no-cache', Pragma: 'no-cache' }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('http_' + response.status);
  const text = await response.text();
  const bytes = Buffer.byteLength(text);
  if (!text.trim()) throw new Error('empty');
  if (bytes > MAX_BYTES) throw new Error('oversize');
  if (/^\s*</.test(text)) throw new Error('html');
  if (text.startsWith('version https://git-lfs.github.com/spec')) throw new Error('lfs');
  return { text, info: { url, ok: true, fetchedAt: nowMs, newestObservedAt: 0, rowCount: 0, byteLength: bytes,
    contentSha256: createHash('sha256').update(text).digest('hex'), etag: response.headers.get('etag') || '', lastModified: response.headers.get('last-modified') || '', error: null }, sourceName };
}

function mergeObservations(sourceSets) {
  const merged = new Map(); let conflictCount = 0;
  for (const set of sourceSets) for (const item of set.observations) {
    const key = item.siteId + ':' + item.observedAt, prior = merged.get(key);
    if (!prior) merged.set(key, item);
    else {
      if (Math.abs(prior.value - item.value) > 0.01) conflictCount++;
      if (item.source === 'archive' && prior.source !== 'archive') merged.set(key, item);
    }
  }
  const histories = new Map();
  for (const item of merged.values()) {
    let history = histories.get(item.siteId); if (!history) histories.set(item.siteId, history = []);
    history.push(item);
  }
  for (const history of histories.values()) history.sort((a, b) => b.observedAt - a.observedAt);
  return { histories, conflictCount };
}

function lagState(minutes) {
  return minutes <= 150 ? 'normal' : minutes <= 360 ? 'delayed' : 'overdue';
}

async function loadNyccas(options = {}) {
  const nowMs = options.nowMs ?? Date.now(), fetchImpl = options.fetchImpl ?? fetch;
  const stationResult = await fetchCsv(STATIONS_URL, 'stations', fetchImpl, nowMs);
  const stations = parseStations(stationResult.text);
  stationResult.info.rowCount = stations.byId.size;
  const [currentUrl, previousUrl] = archiveUrls(nowMs);
  const candidates = [{ name: 'portal', url: PORTAL_URL, parse: parsePortal }];
  if (process.env.NYCCAS_DUAL_SOURCE !== '0') candidates.push(
    { name: 'archiveCurrent', url: currentUrl, parse: parseArchive },
    { name: 'archivePrevious', url: previousUrl, parse: parseArchive }
  );
  const settled = await Promise.all(candidates.map(async candidate => {
    try {
      const result = await fetchCsv(candidate.url, candidate.name, fetchImpl, nowMs);
      const observations = candidate.parse(result.text, stations, nowMs);
      result.info.rowCount = observations.length;
      result.info.newestObservedAt = Math.max(...observations.map(item => item.observedAt));
      return { ...candidate, observations, info: result.info };
    } catch (error) {
      return { ...candidate, observations: [], info: { url: candidate.url, ok: false, fetchedAt: nowMs, newestObservedAt: 0, rowCount: 0, byteLength: 0, contentSha256: '', etag: '', lastModified: '', error: errorCode(error) } };
    }
  }));
  const successful = settled.filter(result => result.info.ok);
  if (!successful.length) throw new Error('nyccas all sources failed: ' + settled.map(result => result.name + '=' + result.info.error).join(','));
  const { histories, conflictCount } = mergeObservations(successful);
  if (!histories.size) throw new Error('nyccas empty');
  const latest = [...histories.values()].map(history => history[0]);
  const selected = new Set(latest.map(item => item.source));
  const selectedSource = selected.size > 1 ? 'mixed' : [...selected][0];
  const observedAt = Math.max(...latest.map(item => item.observedAt));
  const sourceLagMinutes = Math.max(0, Math.round((nowMs - observedAt) / 60_000));
  let sourceChanged = false;
  const sources = { stations: stationResult.info };
  for (const result of settled) {
    sources[result.name] = result.info;
    const previousState = previousStates.get(result.name);
    if (previousState !== undefined && previousState !== result.info.ok) console.log('[air-quality] source_' + (result.info.ok ? 'recovered' : 'failed'), 'source=' + result.name, result.info.ok ? 'newest=' + new Date(result.info.newestObservedAt).toISOString() : 'reason=' + result.info.error);
    previousStates.set(result.name, result.info.ok);
    if (result.info.ok) {
      const previousHash = previousHashes.get(result.name);
      if (previousHash && previousHash !== result.info.contentSha256) { sourceChanged = true; console.log('[air-quality] source_changed', 'source=' + result.name, 'sha=' + result.info.contentSha256.slice(0, 12), 'newest=' + new Date(result.info.newestObservedAt).toISOString(), 'rows=' + result.info.rowCount); }
      previousHashes.set(result.name, result.info.contentSha256);
    }
  }
  if (conflictCount) console.warn('[air-quality] source_conflict', 'count=' + conflictCount, 'preferred=archive');
  const currentLagState = lagState(sourceLagMinutes);
  if (previousLagState && currentLagState !== previousLagState) console.log('[air-quality] source_' + (currentLagState === 'normal' ? 'recovered' : 'stalled'), 'newest=' + new Date(observedAt).toISOString(), 'ageMinutes=' + sourceLagMinutes);
  previousLagState = currentLagState;
  return { histories, observedAt, selectedSource, sourceChanged, sourceConflictCount: conflictCount, sourceLagMinutes, sources };
}

module.exports = { STATIONS_URL, PORTAL_URL, archiveUrls, parseTimestamp, parseEasternTimestamp, parseStations, parsePortal, parseArchive, mergeObservations, fetchCsv, loadNyccas };
