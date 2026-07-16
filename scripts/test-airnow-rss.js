const assert = require('node:assert/strict');
const { FEEDS, parseCurrent, parseForecast, parseActionDay, loadAirNow } = require('../lib/airnow-rss');

const wrap = (title, body) => `<?xml version="1.0"?><rss><channel><title>${title}</title><pubDate>Thu, 16 Jul 2026 08:15:04 EST</pubDate><item><description>${body}</description></item></channel></rss>`;
const currentXml = wrap('New York City Region, NY - Current Air Quality', '&lt;div&gt;&lt;b&gt;Current Air Quality:&lt;/b&gt; 07/16/26 9:00 AM EDT&lt;br /&gt;Unhealthy - 161 AQI - Particle Pollution (2.5 microns)&lt;br /&gt;Good - 24 AQI - Ozone&lt;/div&gt;');
const forecastXml = wrap('New York City Region, NY - Air Quality Forecast', '&lt;div&gt;Today, 07/16/2026: Unhealthy - 200 AQI - Particle Pollution (2.5 microns)&lt;/div&gt;');
const actionXml = wrap('New York City Region, NY - Air Quality Health Advisory Notification', '&lt;div&gt;Air Quality Health Advisory called for New York City Region, NY.&lt;/div&gt;');

const current = parseCurrent(currentXml);
assert.equal(current.reportingArea, 'New York City Region, NY');
assert.equal(current.observed, '07/16/26 9:00 AM EDT');
assert.deepEqual(current.pollutants, [
  { category: 'Unhealthy', aqi: 161, pollutant: 'Particle Pollution (2.5 microns)' },
  { category: 'Good', aqi: 24, pollutant: 'Ozone' }
]);
assert.deepEqual(parseForecast(forecastXml).forecasts, [
  { period: 'Today', date: '07/16/2026', category: 'Unhealthy', aqi: 200, pollutant: 'Particle Pollution (2.5 microns)' }
]);
assert.equal(parseActionDay(actionXml).active, true);

const bodies = { [FEEDS.current]: currentXml, [FEEDS.forecast]: forecastXml, [FEEDS.actionDay]: actionXml };
(async () => {
  const result = await loadAirNow({ cache: false, nowMs: Date.UTC(2026, 6, 16, 13), fetchImpl: async url => new Response(bodies[url], { status: 200 }) });
  assert.equal(result.current.pollutants[0].aqi, 161);
  assert.equal(result.forecast[0].aqi, 200);
  assert.equal(result.actionDay.active, true);
  assert.ok(Object.values(result.sources).every(source => source.ok));
  console.log('airnow rss tests: pass');
})().catch(error => { console.error(error); process.exit(1); });
