const assert = require('node:assert/strict');
const { archiveUrls, parseTimestamp, parseEasternTimestamp, parseStations, parsePortal, parseArchive, mergeObservations, loadNyccas } = require('../lib/nyccas-source');

const stationsCsv = '\uFEFFSiteID,Location,loc_col,Latitude,Longitude\r\nA1,Alpha,Alpha,40.70,-73.90\r\nB2,Beta,Beta,40.71,-73.91\r\n,DEC Monitor Average,DEC_Avg,40.14458,-71.70936\r\n';
const stations = parseStations(stationsCsv);
assert.equal(stations.byId.size, 2);
assert.equal(stations.byName.get('alpha').id, 'A1');
assert.equal(parseTimestamp('2026-07-16 06:00:00.000'), Date.UTC(2026, 6, 16, 6));
assert.equal(parseEasternTimestamp('2026-01-15 06:00:00.000'), Date.UTC(2026, 0, 15, 11));
assert.equal(parseEasternTimestamp('2026-07-16 06:00:00.000'), Date.UTC(2026, 6, 16, 10));
assert.deepEqual(archiveUrls(Date.UTC(2027, 0, 1)), [
  'https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/hist/csv/2027/1.csv',
  'https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/hist/csv/2026/12.csv'
]);

const now = Date.UTC(2026, 0, 15, 13);
const portal = parsePortal('SiteName,Operator,starttime,timeofday,Value\nAlpha,nyccas,2026-01-15 06:00:00.000,06:00 AM,8.5\nBeta,nyccas,2020-01-01 00:00:00.000,12:00 AM,5.0\nAlpha,nyccas,2026-01-15 09:00:00.000,09:00 AM,9.0\n', stations, now);
assert.equal(portal.length, 2);
assert.equal(portal[0].observedAt, Date.UTC(2026, 0, 15, 11));
assert.equal(portal[1].observedAt, Date.UTC(2020, 0, 1, 5));

const archive = parseArchive('ID,SiteID,ObservationTimeUTC,Value\n1,A1,2026-01-15 11:00:00.000,8.7\n2,B2,2026-01-15 12:00:00.000,7.2\n', stations, now);
const merged = mergeObservations([{ observations: portal }, { observations: archive }]);
assert.equal(merged.conflictCount, 1);
assert.equal(merged.histories.get('A1')[0].source, 'archive');
assert.equal(merged.histories.get('A1')[0].value, 8.7);
assert.equal(merged.histories.get('B2')[0].value, 7.2);

const bodies = {
  'portal/station-new.csv': stationsCsv,
  'portal/view.csv': 'SiteName,Operator,starttime,timeofday,Value\nAlpha,nyccas,2026-01-15 06:00:00.000,06:00 AM,8.5\nAlpha,nyccas,2026-01-15 05:00:00.000,05:00 AM,8.0\n',
  'hist/csv/2026/1.csv': 'ID,SiteID,ObservationTimeUTC,Value\n1,A1,2026-01-15 10:00:00.000,8.0\n2,B2,2026-01-15 12:00:00.000,7.2\n',
  'hist/csv/2025/12.csv': 'ID,SiteID,ObservationTimeUTC,Value\n3,A1,2025-12-31 23:00:00.000,4.0\n'
};
const requests = [];
async function fetchImpl(url, options) {
  requests.push({ url: String(url), options });
  const key = Object.keys(bodies).find(path => String(url).includes(path));
  return key ? new Response(bodies[key], { status: 200, headers: { etag: '"fixture"', 'last-modified': 'Thu, 15 Jan 2026 13:00:00 GMT' } }) : new Response('', { status: 404 });
}

(async () => {
  const result = await loadNyccas({ nowMs: now, fetchImpl });
  assert.equal(result.selectedSource, 'mixed');
  assert.equal(result.observedAt, Date.UTC(2026, 0, 15, 12));
  assert.equal(result.sourceLagMinutes, 60);
  assert.equal(result.histories.get('A1')[0].source, 'portal');
  assert.equal(result.histories.get('B2')[0].source, 'archive');
  assert.equal(result.sources.portal.rowCount, 2);
  assert.equal(result.sources.archiveCurrent.ok, true);
  assert.equal(result.sources.archivePrevious.ok, true);
  assert.ok(result.sources.portal.contentSha256.length === 64);
  assert.ok(requests.every(request => request.url.includes('fresh=')));
  assert.ok(requests.every(request => request.options.cache === 'no-store'));
  assert.ok(requests.every(request => request.options.headers['Cache-Control'] === 'no-cache'));

  const partial = await loadNyccas({ nowMs: now, fetchImpl: async (url, options) => String(url).includes('hist/csv/2026/1.csv') ? new Response('', { status: 404 }) : fetchImpl(url, options) });
  assert.equal(partial.sources.archiveCurrent.ok, false);
  assert.equal(partial.sources.archiveCurrent.error, 'http_404');
  assert.equal(partial.histories.get('A1')[0].source, 'portal');

  process.env.NYCCAS_DUAL_SOURCE = '0';
  const portalOnly = await loadNyccas({ nowMs: now, fetchImpl });
  delete process.env.NYCCAS_DUAL_SOURCE;
  assert.equal(portalOnly.selectedSource, 'portal');
  assert.equal(portalOnly.sources.archiveCurrent, undefined);
  console.log('air-quality source tests: pass');
})().catch(error => { console.error(error); process.exit(1); });
