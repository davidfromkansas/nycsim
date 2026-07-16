const PM25_BREAKS = [[0, 9, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500]];

function pm25Aqi(value) {
  const c = Math.floor(Math.max(0, Number(value)) * 10) / 10;
  const b = PM25_BREAKS.find(x => c >= x[0] && c <= x[1]);
  if (!b) return c > 325.4 ? 500 : null;
  return Math.round((b[3] - b[2]) / (b[1] - b[0]) * (c - b[0]) + b[2]);
}

function aqiCategory(aqi) {
  if (!Number.isFinite(Number(aqi))) return null;
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy for Sensitive Groups';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very Unhealthy';
  return 'Hazardous';
}

function finite(value) {
  return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}

function freshness(observedEpochMin, nowMs = Date.now()) {
  const endedEpochMin = observedEpochMin + 60;
  const ageMinutes = Math.max(0, Math.floor(nowMs / 60000 - endedEpochMin));
  const state = ageMinutes <= 150 ? 'current' : ageMinutes <= 360 ? 'data_delayed' : 'update_overdue';
  return { intervalEndedAt: new Date(endedEpochMin * 60000).toISOString(), ageMinutes, freshness: state };
}

function decodeAirQualityRows(rows, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const recorded = !!options.recorded;
  const out = [];
  for (const row of rows || []) {
    if (!Array.isArray(row)) continue;
    const lat = finite(row[2]), lon = finite(row[3]), latest = finite(row[4]), observedEpochMin = finite(row[5]);
    if (lat == null || lon == null || latest == null || observedEpochMin == null) continue;
    const nowcastAqi = finite(row[7]), average24hPm25 = finite(row[10]);
    const rowFreshness = recorded ? { intervalEndedAt: new Date((observedEpochMin + 60) * 60000).toISOString(), ageMinutes: null, freshness: 'recorded' } : freshness(observedEpochMin, nowMs);
    out.push({
      siteId: String(row[0] || ''), label: String(row[1] || row[0] || 'NYCCAS monitor'), name: String(row[1] || row[0] || 'NYCCAS monitor'),
      lat, lon, latestHourlyPm25: latest, observedAt: new Date(observedEpochMin * 60000).toISOString(), observedEpochMin,
      ...rowFreshness, delta1h: finite(row[6]), nowcastAqi, nowcastCategory: aqiCategory(nowcastAqi),
      peak12hPm25: finite(row[8]), peak12hAt: finite(row[9]) == null ? null : new Date(Number(row[9]) * 60000).toISOString(),
      average24hPm25, average24hObservationCount: finite(row[11]), nowcastPm25: finite(row[12]),
      displayPm25: average24hPm25 == null ? latest : average24hPm25, measured: true, estimated: false, source: 'NYCCAS'
    });
  }
  return out;
}

function sanitizeSources(sources) {
  const out = {};
  for (const [name, source] of Object.entries(sources || {})) {
    if (!source || typeof source !== 'object') continue;
    out[name] = {
      ok: !!source.ok,
      fetchedAt: finite(source.fetchedAt) == null ? null : new Date(Number(source.fetchedAt)).toISOString(),
      newestObservedAt: finite(source.newestObservedAt) == null ? null : new Date(Number(source.newestObservedAt)).toISOString(),
      rowCount: finite(source.rowCount), lastModified: String(source.lastModified || '').slice(0, 80) || null,
      error: source.ok ? null : String(source.error || 'unavailable').slice(0, 80)
    };
  }
  return out;
}

function airQualityOverview(data, sensors, nowMs = Date.now()) {
  const current = sensors.filter(sensor => sensor.freshness === 'current');
  const measured = sensors.map(sensor => sensor.displayPm25).filter(Number.isFinite);
  const nowcasts = sensors.filter(sensor => Number.isFinite(sensor.nowcastAqi)).sort((a, b) => b.nowcastAqi - a.nowcastAqi);
  return {
    official: data && data.airNow ? data.airNow : null,
    officialAvailable: !!(data && data.airNow && data.airNow.current),
    nyccas: {
      citation: data && data.citation || 'NYC Health + Queens College — NYCCAS',
      observedAt: data && Number.isFinite(Number(data.observedAt)) ? new Date(Number(data.observedAt)).toISOString() : null,
      monitorCount: sensors.length, currentMonitorCount: current.length,
      measuredPm25Range: measured.length ? { min: Math.min(...measured), max: Math.max(...measured), metric: '24-hour average when complete, otherwise latest hourly', unit: 'µg/m³' } : null,
      highestStationNowcast: nowcasts[0] ? { siteId: nowcasts[0].siteId, name: nowcasts[0].name, aqi: nowcasts[0].nowcastAqi, category: nowcasts[0].nowcastCategory } : null,
      selectedSource: data && data.selectedSource || null, sourceLagMinutes: finite(data && data.sourceLagMinutes),
      sourceConflictCount: finite(data && data.sourceConflictCount) || 0, stale: !!(data && data.stale),
      checkedAt: data && Number.isFinite(Number(data.fetchedAt)) ? new Date(Number(data.fetchedAt)).toISOString() : new Date(nowMs).toISOString(),
      sources: sanitizeSources(data && data.sources)
    },
    provenance: {
      regional: 'Official AirNow NYC-region current conditions, forecast, and Action Day status',
      monitors: 'Measured NYCCAS PM2.5; station NowCast is derived by NYC SIM using the EPA method',
      neighborhoods: 'NYC SIM interpolation of current NYCCAS station NowCast PM2.5; not official AirNow neighborhood data'
    }
  };
}

function ringCentroid(ring) {
  let area = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i], cross = a[0] * b[1] - b[0] * a[1];
    area += cross; x += (a[0] + b[0]) * cross; y += (a[1] + b[1]) * cross;
  }
  return Math.abs(area) > 1e-12 ? [x / (3 * area), y / (3 * area)] : ring.reduce((sum, point) => [sum[0] + point[0] / ring.length, sum[1] + point[1] / ring.length], [0, 0]);
}

function estimateNeighborhoods(neighborhoods, sensors, distanceMeters) {
  const usable = sensors.filter(sensor => Number.isFinite(sensor.nowcastPm25) && sensor.freshness === 'current');
  const out = [];
  for (const neighborhood of neighborhoods || []) {
    if (neighborhood.kind && neighborhood.kind !== 'nbhd') continue;
    const ring = (neighborhood.rings || []).slice().sort((a, b) => b.length - a.length)[0];
    if (!ring || !ring.length) continue;
    const [lon, lat] = ringCentroid(ring);
    const nearest = usable.map(sensor => ({ sensor, distance: distanceMeters(lat, lon, sensor.lat, sensor.lon) }))
      .sort((a, b) => a.distance - b.distance).slice(0, 4);
    if (!nearest.length) continue;
    let sum = 0, weights = 0;
    for (const item of nearest) {
      const weight = 1 / Math.max(item.distance, 400) ** 2;
      sum += item.sensor.nowcastPm25 * weight; weights += weight;
    }
    const estimatedPm25 = sum / weights, estimatedAqi = pm25Aqi(estimatedPm25), nearestMonitorKm = nearest[0].distance / 1000;
    out.push({
      label: String(neighborhood.name), name: String(neighborhood.name), borough: String(neighborhood.boro || ''), lat, lon,
      estimatedAqi, estimatedPm25: +estimatedPm25.toFixed(2), category: aqiCategory(estimatedAqi),
      confidence: nearestMonitorKm <= 2 ? 'higher' : nearestMonitorKm <= 5 ? 'medium' : 'low',
      nearestMonitorKm: +nearestMonitorKm.toFixed(2), monitorsUsed: nearest.length,
      measured: false, estimated: true, official: false, source: 'NYC SIM interpolation of current NYCCAS monitors'
    });
  }
  return out;
}

function queryAirQualityRows(rows, input = {}, searchOf = row => row.name) {
  const filter = String(input.filter || '').trim().toLowerCase();
  let out = filter ? rows.filter(row => String(searchOf(row) || '').toLowerCase().includes(filter)) : rows.slice();
  const aliases = {
    aqi: input.view === 'neighborhoods' ? 'estimatedAqi' : 'nowcastAqi',
    pm25: input.view === 'neighborhoods' ? 'estimatedPm25' : 'displayPm25', latest: 'latestHourlyPm25',
    change: 'delta1h', peak: 'peak12hPm25', age: 'ageMinutes', distance: 'dist_m', name: 'name'
  };
  const key = aliases[input.sort_by] || input.sort_by;
  if (key) {
    const direction = input.descending === false ? 1 : -1;
    out.sort((a, b) => {
      const av = a[key], bv = b[key], an = typeof av === 'number' && Number.isFinite(av), bn = typeof bv === 'number' && Number.isFinite(bv);
      if (an && bn) return (av - bv) * direction;
      if (an !== bn) return an ? -1 : 1;
      return String(av || '').localeCompare(String(bv || '')) * direction;
    });
  }
  const top = Math.min(Math.max(1, Number(input.top) || 25), 200);
  return { matched: out.length, rows: out.slice(0, top) };
}

module.exports = { pm25Aqi, aqiCategory, freshness, decodeAirQualityRows, sanitizeSources, airQualityOverview, ringCentroid, estimateNeighborhoods, queryAirQualityRows };
