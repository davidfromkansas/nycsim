const assert = require('node:assert/strict');
const { routes } = require('../lib/api-core');
const { airQualityQuery, feedQuery, buildLayer } = require('../lib/agent-core');
const { pm25Aqi, freshness, decodeAirQualityRows, estimateNeighborhoods, queryAirQualityRows } = require('../lib/air-quality-query');

const now = Date.now();
const nowMin = Math.floor(now / 60000);
const rows = [
  ['A1', 'Downtown', 40.7128, -74.006, 8.5, nowMin - 60, 1.2, 44, 12.4, nowMin - 120, 7.25, 24, 8.0],
  ['B2', 'Uptown', 40.81, -73.95, 18.0, nowMin - 211, null, 72, 21.0, nowMin - 240, null, 12, 16.0],
  ['C3', 'Queens', 40.73, -73.82, 5.0, nowMin - 421, -0.5, null, 7.0, nowMin - 480, 5.5, 24, null]
];
const data = {
  source: 'nyccas', observedAt: (nowMin - 60) * 60000, rows, stationCount: 3,
  citation: 'NYC Health + Queens College — NYCCAS', selectedSource: 'mixed', sourceLagMinutes: 60,
  sourceConflictCount: 1, fetchedAt: now,
  sources: {
    portal: { ok: true, fetchedAt: now, newestObservedAt: (nowMin - 60) * 60000, rowCount: 12, contentSha256: 'hidden' },
    archiveCurrent: { ok: false, fetchedAt: now, rowCount: 0, error: 'http_503', url: 'hidden' }
  },
  airNow: {
    reportingArea: 'New York City Region, NY',
    current: { observed: '07/16/26 4:00 PM EDT', pollutants: [{ category: 'Good', aqi: 39, pollutant: 'PM2.5' }] },
    forecast: [{ period: 'Today', date: '07/16/2026', category: 'Good', aqi: 42, pollutant: 'PM2.5' }],
    actionDay: { active: false, text: '' }
  }
};

assert.equal(pm25Aqi(9), 50);
assert.equal(pm25Aqi(9.1), 51);
assert.equal(freshness(nowMin - 210, now).freshness, 'current');
assert.equal(freshness(nowMin - 211, now).freshness, 'data_delayed');
assert.equal(freshness(nowMin - 420, now).freshness, 'data_delayed');
assert.equal(freshness(nowMin - 421, now).freshness, 'update_overdue');

const decoded = decodeAirQualityRows(rows, { nowMs: now });
assert.equal(decoded.length, 3);
assert.equal(decoded[0].average24hPm25, 7.25);
assert.equal(decoded[0].freshness, 'current');
assert.equal(decoded[1].freshness, 'data_delayed');
assert.equal(decoded[2].freshness, 'update_overdue');
assert.equal(decodeAirQualityRows([rows[0]], { recorded: true, nowMs: now })[0].freshness, 'recorded');

const neighborhood = [{ name: 'Fixture', boro: 'Manhattan', kind: 'nbhd', rings: [[[-74.01, 40.7], [-74.0, 40.7], [-74.0, 40.71], [-74.01, 40.71]]] }];
const estimated = estimateNeighborhoods(neighborhood, decoded, (la1, lo1, la2, lo2) => Math.hypot(la2 - la1, lo2 - lo1) * 100000);
assert.equal(estimated.length, 1);
assert.equal(estimated[0].monitorsUsed, 1);
assert.equal(estimated[0].estimated, true);
assert.equal(estimated[0].official, false);
assert.equal(estimated[0].estimatedAqi, pm25Aqi(8));

const sorted = queryAirQualityRows(decoded, { view: 'sensors', sort_by: 'aqi', top: 2 });
assert.deepEqual(sorted.rows.map(row => row.siteId), ['B2', 'A1']);
assert.equal(sorted.matched, 3);

const entry = routes.get('/api/air-quality');
assert.ok(entry);
entry.data = data;
entry.fetchedAt = now;

(async () => {
  const overview = await airQualityQuery({ view: 'overview' });
  assert.equal(overview.officialAvailable, true);
  assert.equal(overview.official.current.pollutants[0].aqi, 39);
  assert.equal(overview.nyccas.monitorCount, 3);
  assert.equal(overview.nyccas.currentMonitorCount, 1);
  assert.equal(overview.nyccas.sources.portal.contentSha256, undefined);
  assert.equal(overview.nyccas.sources.archiveCurrent.error, 'http_503');

  const sensors = await airQualityQuery({ view: 'sensors', sort_by: 'pm25', top: 2 });
  assert.equal(sensors.matched, 3);
  assert.deepEqual(sensors.rows.map(row => row.siteId), ['B2', 'A1']);
  assert.match(sensors.note, /Measured NYCCAS/);

  const nearby = await airQualityQuery({ view: 'sensors', near: { lat: 40.7128, lon: -74.006, radius_m: 1000 } });
  assert.equal(nearby.matched, 1);
  assert.equal(nearby.rows[0].siteId, 'A1');
  assert.equal(nearby.rows[0].dist_m, 0);

  const generic = await feedQuery({ feed: 'air_quality', filter: 'Downtown' });
  assert.equal(generic.matched, 1);
  assert.equal(generic.rows[0].siteId, 'A1');

  const neighborhoods = await airQualityQuery({ view: 'neighborhoods', area: 'Manhattan', sort_by: 'aqi', top: 5 });
  assert.ok(neighborhoods.matched > 0);
  assert.ok(neighborhoods.rows.every(row => row.borough === 'Manhattan' && row.estimated && !row.official));
  assert.match(neighborhoods.note, /not official AirNow/);

  const sensorLayer = await buildLayer({ title: 'Air monitors', source: { air_quality: { view: 'sensors', sort_by: 'aqi', top: 2 } } });
  assert.equal(sensorLayer.ok, true);
  assert.equal(sensorLayer.points, 2);
  assert.match(sensorLayer.sample[0], /AQI/);

  const neighborhoodLayer = await buildLayer({ title: 'Estimated AQI', source: { air_quality: { view: 'neighborhoods', area: 'Manhattan', top: 3 } } });
  assert.equal(neighborhoodLayer.ok, true);
  assert.equal(neighborhoodLayer.points, 3);

  console.log('agent air-quality tests: pass');
})().catch(error => { console.error(error); process.exit(1); });
