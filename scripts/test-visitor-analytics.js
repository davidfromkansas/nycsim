const assert = require('node:assert/strict');
const { rollingReturningVisitors, dailyUniqueVisitors, nyDayString } = require('../lib/visitor-log-view');
const { ignoredRequest } = require('../lib/visitor-log');

const noonNY = day => Date.parse(day + 'T16:00:00Z'); // dates used below are in EDT
const event = (visitor, day, n = 0) => ({ visitor, ts: noonNY(day) + n * 1000 });
const links = [];
const today = noonNY('2026-07-19');
const calculate = rows => rollingReturningVisitors(rows, links, today);

// 1. Today only: no rolling return metric.
let r = calculate([event('today-only', '2026-07-19')]);
assert.equal(r.totalUniqueVisitorsToday, 1);

// Daily chart matches Vercel's daily-unique semantics: one identity per day,
// with signed-in cookie rotations/devices collapsed to their stable account.
const daily = dailyUniqueVisitors([
  event('cookie-a', '2026-07-18'), event('cookie-a', '2026-07-18', 1),
  event('cookie-b', '2026-07-18'), event('anonymous', '2026-07-18'),
  event('cookie-a', '2026-07-19'), event('anonymous', '2026-07-19')
], [
  { visitor: 'cookie-a', user: 'account-1' }, { visitor: 'cookie-b', user: 'account-1' }
], ['2026-07-17', '2026-07-18', '2026-07-19']);
assert.deepEqual(daily, [
  { day: '2026-07-17', unique_visitors: 0 },
  { day: '2026-07-18', unique_visitors: 2 },
  { day: '2026-07-19', unique_visitors: 2 }
]);
assert.deepEqual(r.returningVisitors, {
  oneDay: { count: 0, percentage: 0 }, sevenDay: { count: 0, percentage: 0 }, thirtyDay: { count: 0, percentage: 0 }
});

// 2. Yesterday + today: all three.
r = calculate([event('daily', '2026-07-18'), event('daily', '2026-07-19')]);
assert.deepEqual(r.returningVisitors, {
  oneDay: { count: 1, percentage: 100 }, sevenDay: { count: 1, percentage: 100 }, thirtyDay: { count: 1, percentage: 100 }
});

// 3. Five days ago + today: 7- and 30-day only.
r = calculate([event('five', '2026-07-14'), event('five', '2026-07-19')]);
assert.equal(r.returningVisitors.oneDay.count, 0);
assert.equal(r.returningVisitors.sevenDay.count, 1);
assert.equal(r.returningVisitors.thirtyDay.count, 1);

// 4. Twenty days ago + today: 30-day only.
r = calculate([event('twenty', '2026-06-29'), event('twenty', '2026-07-19')]);
assert.equal(r.returningVisitors.oneDay.count, 0);
assert.equal(r.returningVisitors.sevenDay.count, 0);
assert.equal(r.returningVisitors.thirtyDay.count, 1);

// 5 + 8. Multiple same-day sessions collapse to one visitor/day and do not qualify.
r = calculate([event('repeat-today', '2026-07-19'), event('repeat-today', '2026-07-19', 1), event('repeat-today', '2026-07-19', 2)]);
assert.equal(r.totalUniqueVisitorsToday, 1);
assert.equal(r.returningVisitors.thirtyDay.count, 0);

// 6. Seven calendar days ago lies outside today-6 ... today.
r = calculate([event('seven-edge', '2026-07-12'), event('seven-edge', '2026-07-19')]);
assert.equal(r.returningVisitors.sevenDay.count, 0);
assert.equal(r.returningVisitors.thirtyDay.count, 1);

// 7. Thirty calendar days ago lies outside today-29 ... today.
r = calculate([event('thirty-edge', '2026-06-19'), event('thirty-edge', '2026-07-19')]);
assert.equal(r.returningVisitors.thirtyDay.count, 0);

// 9. Today's unique audience is always the percentage denominator.
r = calculate([
  event('returning', '2026-07-18'), event('returning', '2026-07-19'),
  event('new-1', '2026-07-19'), event('new-2', '2026-07-19')
]);
assert.equal(r.totalUniqueVisitorsToday, 3);
assert.deepEqual(r.returningVisitors.oneDay, { count: 1, percentage: 33.3 });

// Stable authenticated identity deduplicates rotated cookies/devices.
r = rollingReturningVisitors([
  event('cookie-a', '2026-07-18'), event('cookie-b', '2026-07-19'), event('cookie-c', '2026-07-19')
], [
  { visitor: 'cookie-a', user: 'account-1' }, { visitor: 'cookie-b', user: 'account-1' },
  { visitor: 'cookie-c', user: 'account-1' }
], today);
assert.equal(r.totalUniqueVisitorsToday, 1);
assert.equal(r.returningVisitors.oneDay.count, 1);

// 10. New York calendar assignment survives spring-forward and fall-back DST.
assert.equal(nyDayString(Date.parse('2026-03-08T04:30:00Z')), '2026-03-07');
assert.equal(nyDayString(Date.parse('2026-03-08T05:30:00Z')), '2026-03-08');
assert.equal(nyDayString(Date.parse('2026-11-01T05:30:00Z')), '2026-11-01');
assert.equal(nyDayString(Date.parse('2026-11-02T04:30:00Z')), '2026-11-01');
r = rollingReturningVisitors([
  { visitor: 'dst', ts: Date.parse('2026-03-08T05:30:00Z') },
  { visitor: 'dst', ts: Date.parse('2026-03-09T04:30:00Z') }
], [], Date.parse('2026-03-09T16:00:00Z'));
assert.equal(r.returningVisitors.oneDay.count, 1);

// Zero denominator is explicitly 0%, never NaN/Infinity.
r = calculate([event('past-only', '2026-07-18')]);
assert.equal(r.totalUniqueVisitorsToday, 0);
assert.deepEqual(r.returningVisitors.oneDay, { count: 0, percentage: 0 });

// Invalid events are excluded; a valid anonymous visitor identifier is included.
r = calculate([{ ts: today }, { visitor: 'bad-time', ts: NaN }, event('anonymous-id', '2026-07-19')]);
assert.equal(r.totalUniqueVisitorsToday, 1);

// Intake rules reject bots, non-production Vercel traffic, and configured internal IPs.
const request = (ua, ip = '203.0.113.8') => ({ headers: { 'user-agent': ua, 'x-forwarded-for': ip }, socket: {} });
assert.equal(ignoredRequest(request('Googlebot/2.1')), 'bot');
process.env.VERCEL_ENV = 'preview';
assert.equal(ignoredRequest(request('Mozilla/5.0')), 'non-production');
process.env.VERCEL_ENV = 'production'; process.env.ANALYTICS_INTERNAL_IPS = '127.0.0.1,203.0.113.8';
assert.equal(ignoredRequest(request('Mozilla/5.0')), 'internal');
process.env.ANALYTICS_INTERNAL_IPS = '';
assert.equal(ignoredRequest(request('Mozilla/5.0')), null);
delete process.env.VERCEL_ENV;

console.log('visitor rolling analytics tests: ok');
