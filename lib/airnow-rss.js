const FEEDS = {
  forecast: 'https://feeds.airnowapi.org/rss/forecast/94.xml',
  actionDay: 'https://feeds.airnowapi.org/rss/actionday/94.xml',
  current: 'https://feeds.airnowapi.org/rss/realtime/94.xml'
};

let cached = null;
let cachedAt = 0;
let pending = null;

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const match = String(xml || '').match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i'));
  return match ? match[1].trim() : '';
}

function linesFromDescription(xml) {
  const item = tag(xml, 'item');
  const decoded = decodeEntities(tag(item, 'description'))
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decoded.split(/\n+/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function reportingArea(xml) {
  return decodeEntities(tag(xml, 'title')).replace(/\s+-\s+(?:Current Air Quality|Air Quality Forecast|Air Quality Health Advisory Notification).*$/i, '').trim();
}

function parsePollutant(line) {
  const match = line.match(/^(Good|Moderate|Unhealthy for Sensitive Groups|Unhealthy|Very Unhealthy|Hazardous)\s*-\s*(\d+)\s+AQI\s*-\s*(.+)$/i);
  return match ? { category: match[1], aqi: +match[2], pollutant: match[3].trim() } : null;
}

function parseCurrent(xml) {
  const lines = linesFromDescription(xml);
  const observedMatch = lines.join(' ').match(/\d{2}\/\d{2}\/\d{2}\s+\d{1,2}:\d{2}\s+[AP]M\s+[A-Z]{3}/i);
  const observed = observedMatch ? observedMatch[0] : '';
  return {
    reportingArea: reportingArea(xml),
    published: decodeEntities(tag(xml, 'pubDate')),
    observed,
    pollutants: lines.map(parsePollutant).filter(Boolean)
  };
}

function parseForecast(xml) {
  const lines = linesFromDescription(xml), forecasts = [];
  for (const line of lines) {
    const match = line.match(/^([^,]+),\s*(\d{2}\/\d{2}\/\d{4}):\s*(Good|Moderate|Unhealthy for Sensitive Groups|Unhealthy|Very Unhealthy|Hazardous)\s*-\s*(\d+)\s+AQI\s*-\s*(.+)$/i);
    if (match) forecasts.push({ period: match[1], date: match[2], category: match[3], aqi: +match[4], pollutant: match[5].trim() });
  }
  return { reportingArea: reportingArea(xml), published: decodeEntities(tag(xml, 'pubDate')), forecasts };
}

function parseActionDay(xml) {
  const lines = linesFromDescription(xml);
  const text = lines.find(line => /Action Day|Health Advisory/i.test(line)) || '';
  return { reportingArea: reportingArea(xml), published: decodeEntities(tag(xml, 'pubDate')), active: /called for|declared|in effect/i.test(text), text };
}

async function fetchFeed(name, url, fetchImpl, nowMs) {
  try {
    const response = await fetchImpl(url, { cache: 'no-store', headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'Cache-Control': 'no-cache', 'User-Agent': 'manhattan-island' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('http_' + response.status);
    const text = await response.text();
    return { name, text, source: { ok: true, url, fetchedAt: nowMs, byteLength: Buffer.byteLength(text) } };
  } catch (error) {
    return { name, text: '', source: { ok: false, url, fetchedAt: nowMs, byteLength: 0, error: String(error.message || error).slice(0, 120) } };
  }
}

async function fetchAirNow(fetchImpl, nowMs) {
  const results = await Promise.all(Object.entries(FEEDS).map(([name, url]) => fetchFeed(name, url, fetchImpl, nowMs)));
  const byName = Object.fromEntries(results.map(result => [result.name, result]));
  if (!results.some(result => result.source.ok)) throw new Error('airnow all feeds failed');
  return {
    reportingArea: results.map(result => result.text && reportingArea(result.text)).find(Boolean) || 'New York City Region, NY',
    current: byName.current.source.ok ? parseCurrent(byName.current.text) : null,
    forecast: byName.forecast.source.ok ? parseForecast(byName.forecast.text).forecasts : [],
    actionDay: byName.actionDay.source.ok ? parseActionDay(byName.actionDay.text) : null,
    sources: Object.fromEntries(results.map(result => [result.name, result.source]))
  };
}

async function loadAirNow(options = {}) {
  const nowMs = options.nowMs ?? Date.now(), fetchImpl = options.fetchImpl ?? fetch, ttlMs = options.ttlMs ?? 15 * 60_000;
  if (options.cache !== false && cached && nowMs - cachedAt < ttlMs) return cached;
  if (!pending || options.cache === false) {
    pending = fetchAirNow(fetchImpl, nowMs).then(result => {
      if (options.cache !== false) { cached = result; cachedAt = nowMs; }
      return result;
    }).finally(() => { pending = null; });
  }
  return pending;
}

module.exports = { FEEDS, decodeEntities, parseCurrent, parseForecast, parseActionDay, loadAirNow };
