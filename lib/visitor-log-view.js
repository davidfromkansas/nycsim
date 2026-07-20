/* GET /api/visitor-log — private 1–90 day return-visitor report.
   Uses the existing AGENT_LOG_KEY gate; unset means inert (404).

   ?key=<AGENT_LOG_KEY>&days=30        aggregate report
   ?key=<AGENT_LOG_KEY>&days=30&full=1 include pseudonymous visitor rows */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listVisitLogs, readVisit, listVisitorLinks, readVisitorLink, enabled } = require('./visitor-log');
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
/* Match /api/agent-log: only failed passwords count, so the dashboard's valid
   five-minute refreshes never trip the limiter. State is per warm instance. */
const BAD = new Map();
const BAD_MAX = 10, BAD_WINDOW_MS = 3600_000;
function authThrottled(ip) {
  const now = Date.now();
  const attempts = (BAD.get(ip) || []).filter(t => now - t < BAD_WINDOW_MS);
  BAD.set(ip, attempts);
  if (BAD.size > 5000) BAD.clear();
  return attempts.length >= BAD_MAX;
}
function noteBadKey(ip) { BAD.get(ip).push(Date.now()); }
function dayString(ms) { return new Date(ms).toISOString().slice(0, 10); }
const NY_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function nyDayString(ms) {
  const p = Object.fromEntries(NY_DAY.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function shiftDay(day, delta) {
  const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function dateRange(days, now = Date.now()) {
  const end = Date.parse(dayString(now) + 'T00:00:00Z');
  return Array.from({ length: days }, (_, i) => dayString(end - (days - 1 - i) * 86_400_000));
}
function nyDateRange(days, now = Date.now()) {
  const today = nyDayString(now);
  return Array.from({ length: days }, (_, i) => shiftDay(today, -(days - 1 - i)));
}
function summarize(rows, days, includeVisitors) {
  const people = new Map(), byDay = {};
  for (const day of days) byDay[day] = { visits: 0, visitors: new Set(), new_visits: 0, returning_visits: 0 };
  for (const r of rows) {
    if (!r || !r.visitor || !Number.isFinite(r.ts)) continue;
    const day = nyDayString(r.ts), d = byDay[day];
    if (!d) continue;
    d.visits++; d.visitors.add(r.visitor);
    if (r.returning) d.returning_visits++; else d.new_visits++;
    let p = people.get(r.visitor);
    if (!p) {
      p = { visitor: r.visitor, first_seen: r.ts, last_seen: r.ts, visits: 0, days: new Set(), returning: false,
        country: r.country || null, region: r.region || null, device: r.device || null, referrer: r.referrer || null };
      people.set(r.visitor, p);
    }
    p.first_seen = Math.min(p.first_seen, r.ts); p.last_seen = Math.max(p.last_seen, r.ts);
    p.visits++; p.days.add(day); p.returning ||= !!r.returning;
    p.country = r.country || p.country; p.region = r.region || p.region; p.device = r.device || p.device;
  }
  const visitorRows = [...people.values()].map(p => ({ ...p, days: p.days.size,
    first_seen: new Date(p.first_seen).toISOString(), last_seen: new Date(p.last_seen).toISOString() }))
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  const report = {
    window: { from: days[0], through: days[days.length - 1], days: days.length, timezone: 'America/New_York' },
    visits: Object.values(byDay).reduce((n, d) => n + d.visits, 0),
    unique_visitors: people.size,
    returning_visitors: visitorRows.filter(p => p.returning).length,
    repeat_visitors_in_window: visitorRows.filter(p => p.days > 1).length,
    by_day: days.map(day => ({ day, visits: byDay[day].visits, unique_visitors: byDay[day].visitors.size,
      new_visits: byDay[day].new_visits, returning_visits: byDay[day].returning_visits }))
  };
  if (includeVisitors) report.visitors = visitorRows;
  return report;
}
async function readInBatches(blobs) {
  const rows = [];
  for (let i = 0; i < blobs.length; i += 50) {
    rows.push(...await Promise.all(blobs.slice(i, i + 50).map(b => readVisit(b.downloadUrl || b.url).catch(() => null))));
  }
  return rows.filter(Boolean);
}
async function listDay(day) {
  let cursor = null, blobs = [];
  do {
    const page = await listVisitLogs('visitor-logs/' + day + '/', 1000, cursor);
    blobs.push(...(page.blobs || []));
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor && blobs.length < 100_000);
  return blobs;
}
async function listDays(days) { // bounded concurrency avoids 92 serial Blob round-trips
  const blobs = [];
  for (let i = 0; i < days.length; i += 12) {
    const batch = await Promise.all(days.slice(i, i + 12).map(listDay));
    for (const rows of batch) blobs.push(...rows);
  }
  return blobs;
}
function attachLinks(report, links) {
  const byVisitor = new Map(links.filter(Boolean).map(link => [link.visitor, link.user]));
  let identified = 0;
  for (const p of report.visitors || []) {
    const account = byVisitor.get(p.visitor) || null;
    p.identified = !!account;
    if (account) { p.account = account; identified++; }
  }
  report.identified_visitors = identified;
  report.anonymous_visitors = report.unique_visitors - identified;
  return report;
}
function rollingReturningVisitors(rows, links, now = Date.now()) {
  const linkMap = new Map(links.filter(Boolean).map(link => [link.visitor, link.user]));
  const people = new Map(), today = nyDayString(now);
  for (const r of rows) {
    if (!r || !r.visitor || !Number.isFinite(r.ts)) continue;
    const day = nyDayString(r.ts);
    if (day > today) continue;
    const account = linkMap.get(r.visitor);
    const id = account ? 'account:' + account : 'visitor:' + r.visitor; // cookie rotations collapse after Google login
    if (!people.has(id)) people.set(id, new Set());
    people.get(id).add(day); // sessions/page views collapse to one active calendar day
  }

  const yesterday = shiftDay(today, -1), sevenStart = shiftDay(today, -6), thirtyStart = shiftDay(today, -29);
  let total = 0, one = 0, seven = 0, thirty = 0;
  for (const activeDays of people.values()) {
    if (!activeDays.has(today)) continue; // every numerator and denominator is today's audience
    total++;
    if (activeDays.has(yesterday)) one++;
    if ([...activeDays].some(day => day >= sevenStart && day < today)) seven++;
    if ([...activeDays].some(day => day >= thirtyStart && day < today)) thirty++;
  }
  const metric = count => ({ count, percentage: total ? +(count * 100 / total).toFixed(1) : 0 });
  return {
    date: today,
    timezone: 'America/New_York',
    identityBasis: 'Google account when linked; otherwise 90-day browser cookie',
    totalUniqueVisitorsToday: total,
    returningVisitors: { oneDay: metric(one), sevenDay: metric(seven), thirtyDay: metric(thirty) }
  };
}

function dailyUniqueVisitors(rows, links, days) {
  const linkMap = new Map(links.filter(Boolean).map(link => [link.visitor, link.user]));
  const byDay = new Map(days.map(day => [day, new Set()]));
  for (const r of rows) {
    if (!r || !r.visitor || !Number.isFinite(r.ts)) continue;
    const visitors = byDay.get(nyDayString(r.ts));
    if (!visitors) continue;
    const account = linkMap.get(r.visitor);
    visitors.add(account ? 'account:' + account : 'visitor:' + r.visitor);
  }
  return days.map(day => ({ day, unique_visitors: byDay.get(day).size }));
}

async function handleVisitorLog(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const key = viewerKey();
  if (!key) return sendJSON(res, { error: 'visitor viewer disabled (set AGENT_LOG_KEY)' }, 404);
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
  if (authThrottled(ip)) return sendJSON(res, { error: 'too many attempts — try again in an hour' }, 429);
  if (!keyMatches(url.searchParams.get('key'), key)) { noteBadKey(ip); return sendJSON(res, { error: 'unauthorized' }, 401); }
  if (!enabled()) return sendJSON(res, { error: 'visitor logging not configured' }, 503);
  const count = Number(url.searchParams.get('days')) || 30;
  const n = Math.min(Math.max(1, Math.floor(count)), 90);
  const days = nyDateRange(n);
  // Two extra UTC paths cover the requested NYC dates across midnight; rolling
  // retention always needs today plus the prior 29 New York calendar days.
  const scanDays = dateRange(Math.max(n + 2, 32));

  try {
    const blobs = await listDays(scanDays);
    const rows = await readInBatches(blobs);
    const report = summarize(rows, days, true);
    const linkBlobs = await listVisitorLinks();
    const links = await readInBatchesWith(linkBlobs, readVisitorLink);
    attachLinks(report, links);
    const daily = dailyUniqueVisitors(rows, links, days);
    report.by_day = report.by_day.map((day, i) => ({ ...day, unique_visitors: daily[i].unique_visitors }));
    report.rollingReturningVisitors = rollingReturningVisitors(rows, links);
    if (url.searchParams.get('full') === '1') report.visitors = report.visitors.slice(0, 1000);
    else delete report.visitors;
    return sendJSON(res, report);
  } catch (e) {
    return sendJSON(res, { error: String(e.message || e) }, 502);
  }
}

async function readInBatchesWith(blobs, reader) {
  const rows = [];
  for (let i = 0; i < blobs.length; i += 50) {
    rows.push(...await Promise.all(blobs.slice(i, i + 50).map(b => reader(b).catch(() => null))));
  }
  return rows.filter(Boolean);
}

module.exports = { handleVisitorLog, summarize, attachLinks, rollingReturningVisitors, dailyUniqueVisitors, nyDayString, dateRange, nyDateRange };
