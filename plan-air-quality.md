# Spec: Live air quality — measured monitors + an honest citywide PM2.5 surface

Audience: a coding agent joining this repo. Read `AGENTS.md` first — especially frozen
geo calibration, `landOK`, the canvas mirror, history gating, mobile memory tiers, and
parallel-work discipline. Anchors below were verified on 2026-07-16; line numbers drift,
so grep before editing. This is a review plan, not authorization to ship.

---

## For nontechnical readers: what would people experience?

**The idea.** A new **AIR QUALITY** control in the city status panel turns the simulation
into a live picture of fine-particle pollution across NYC. A soft, translucent color field
appears just above the land: clearer areas read green, elevated pollution moves through
yellow/orange, and unhealthy conditions become red/purple. Water remains clear and the
buildings, streets, vehicles, and residents stay visible.

**What is actually measured.** About 15 official NYC Health street-level monitors report
PM2.5 once an hour. Each monitor appears as a small glowing beacon. Clicking one flies the
camera closer and opens a label with the location, current PM2.5, recent direction of
change, observation time, and source. Those beacon values are measurements, not guesses.

**How the rest of the city is shown.** There is not a monitor on every block. Between
monitors, the colored surface is an estimate built from NYC Health's citywide long-term
pollution map plus the current monitor readings. The interface explicitly distinguishes
**MEASURED** monitor values from the **ESTIMATED BETWEEN MONITORS** surface. Color becomes
less saturated or lightly stippled where the nearest monitor is far away, making lower
confidence visible rather than hiding it.

**What people can learn.** From a borough-wide view, users can compare current conditions
across all five boroughs. At street level, they can inspect monitors near the BQE, FDR,
Cross Bronx Expressway, Van Wyck, Midtown, Mott Haven, and Staten Island Expressway. A
legend explains the health scale. A small summary states the city range, the cleanest and
highest measured monitor, how fresh the readings are, and whether the current view is live
or historical.

**Time travel.** When recorded hourly data exist, the existing timeline replays the air
field along with traffic and weather. Users can watch a smoke event arrive, compare rush
hour with overnight conditions, or see whether a local spike was brief. Until hourly
recording is enabled, the daily timeline honestly shows only the recorded daily snapshot.

**What it will not claim.** A highway monitor does not represent its whole neighborhood,
an hourly PM2.5 reading is not automatically an official AQI, and the estimated surface is
not a block-by-block measurement. The UI never uses words like "safe" or "healthy here"
without the corresponding EPA category and freshness context.

---

## Product decisions proposed for review

1. **Primary live source:** NYC Health / Queens College NYCCAS real-time PM2.5. It is
   official, public, keyless, street-level, hourly, and NYC-specific.
2. **Default metric:** PM2.5 concentration in `µg/m³`. Offer EPA PM NowCast AQI only when
   the source has enough recent hourly values to calculate it correctly.
3. **Two visual truths:** monitor beacons are measured; the continuous surface is
   estimated. Never blend their labels or provenance.
4. **Layer default:** off on first load so the city keeps its current visual identity;
   one clear AIR QUALITY button turns it on. Remember the choice only in `localStorage`.
5. **Coverage:** all five boroughs. Every geo coordinate uses `subway.geoRaw`; every field
   cell is gated by `landOK`. Do not use Manhattan-only legacy bounds.
6. **No Google Air Quality map data:** Google offers useful 500 m modeled data, but its
   current policy says Air Quality API results shown on a map must be shown on a Google
   Map, requires attribution, and restricts caching. That conflicts with this custom
   Three.js map and recorder. The existing Places key does not change that.
7. **Phase 1 can ship independently:** live monitor beacons, trends, legend, summary, and
   recorder support. The citywide estimated surface is Phase 2 and must not delay truthful
   monitor data.

Owner review questions before implementation:
- Should the layer be off by default (recommended) or on for every visitor?
- Should the field use EPA category colors (familiar) or a less alarmist perceptual ramp?
- Should the first release include only measured beacons, or wait for the estimated field?
- Should hourly recorder scheduling be enabled, increasing writes to the `data` branch?

## Sources, terms, and verified upstream shape

### Live source — NYCCAS

- Repository: `https://github.com/nychealth/nyccas-data`
- Station CSV: `https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/portal/station-new.csv`
- Measurement CSV: `https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/portal/view.csv`
- Public dashboard: `https://a816-dohbesp.nyc.gov/IndicatorPublic/data-features/realtime-air-quality/`
- At verification time the repo was generating files on 2026-07-15/16, so this is the
  active replacement for the retired `nychealth/realtime-air-quality` repository.
- `station-new.csv`: `SiteID,Location,loc_col,Latitude,Longitude`; currently includes 15
  NYC monitor rows plus a synthetic `DEC Monitor Average` row whose coordinates are not
  in NYC. Drop rows outside the NYC bbox and rows without a real `SiteID`.
- `view.csv`: `SiteName,Operator,starttime,timeofday,Value`; multiple hourly observations
  per site. `Value` is calibrated PM2.5 in `µg/m³`.
- The repository README describes observations as UTC. Parse timestamps explicitly as UTC
  after verifying the live format; never let the Vercel host's local timezone decide.
- Data are preliminary and sensors can be unavailable. Public use requires citation to
  New York City Department of Health and Mental Hygiene and Queens College.

Required on-screen source text:

> NYC Health + Queens College, New York City Community Air Survey (NYCCAS). Hourly
> preliminary PM2.5 measurements; estimated surface between monitors.

Link the source text to the public dashboard. Include the measurement's observation time
and a downloaded/retrieved timestamp.

### Static spatial baseline — NYCCAS raster

NYC Open Data dataset `q68s-8qxv`, **NYCCAS Air Pollution Rasters**:
`https://data.cityofnewyork.us/Environment/NYCCAS-Air-Pollution-Rasters/q68s-8qxv`

It contains annual predicted surfaces for PM2.5, NO2, black carbon, and NO, plus seasonal
pollutants. This is a long-term land-use-regression baseline, not live data. The coding
agent must inspect the current ZIP, identify the newest PM2.5 annual raster and CRS, record
the source year in generated metadata, and stop for owner review if the latest usable
surface is unexpectedly old or its redistribution terms are unclear.

Do not download or decode the raster in visitors' browsers. Add an offline bake script
that samples it into a compact city grid using the repo's frozen geo calibration. Commit
only the derived compact artifact if its source terms allow redistribution; otherwise
perform the bake during an approved data-preparation workflow and document provenance.

### Secondary/fallback sources

- **AirNow:** good official city/reporting-area validation and alerts, but too sparse/coarse
  to portray neighborhood differences. Optional later citywide check, not the surface.
- **PurpleAir:** denser community sensors, but requires an API key/points, calibration,
  licensing, and separate attribution. Explicitly out of scope for Phases 1–2.
- **Open-Meteo/CAMS:** keyless but global model resolution is too coarse for NYC
  neighborhood differences. Do not use it to create false street-level detail.

## Data semantics — concentration is not automatically AQI

The live CSV contains one-hour PM2.5 concentration. Display it directly as `µg/m³`.
Do not convert a single hourly observation to "current AQI".

If NowCast is implemented, follow EPA's PM NowCast exactly:

1. Keep the preceding 12 hourly PM2.5 values per station.
2. Require at least 2 valid observations among the latest 3 hours.
3. Find the 12-hour minimum and maximum.
4. `weight = max(0.5, 1 - (max - min) / max)`; guard `max === 0` as weight 1.
5. Calculate the recency-weighted concentration using `weight ** hoursAgo`.
6. Truncate PM2.5 to one decimal before AQI interpolation, per EPA guidance.
7. Convert with the EPA breakpoints effective 2024-05-06:

| PM2.5 µg/m³ | AQI | Category |
|---|---:|---|
| 0.0–9.0 | 0–50 | Good |
| 9.1–35.4 | 51–100 | Moderate |
| 35.5–55.4 | 101–150 | Unhealthy for Sensitive Groups |
| 55.5–125.4 | 151–200 | Unhealthy |
| 125.5–225.4 | 201–300 | Very Unhealthy |
| 225.5–325.4 | 301–500 | Hazardous |

If completeness fails, return `aqi:null`; the UI continues to show concentration. Unit
test every breakpoint boundary and missing-data condition.

## Phase 1 — server route and measured monitor layer

### Server: `lib/api-core.js`

Reuse the existing `csvObjects()` parser; do not add a dependency.

Add `fetchAirQuality()` near the other public live fetchers:

1. Fetch station and measurement CSVs concurrently with a 10 s timeout.
2. Reject unless both responses are OK and both parse to nonempty arrays.
3. Build station metadata by `loc_col`/normalized name; accept only finite coordinates
   inside the full NYC bbox (`40.45–41.05`, `-74.35–-73.55`) and a nonempty `SiteID`.
4. Group measurements by normalized `SiteName`; parse finite `Value` in a defensible range
   (`0–1000 µg/m³`), parse UTC timestamp, sort newest first, and retain 24 hours.
5. A station's current reading is fresh at age <= 150 minutes, stale at 150 minutes–6
   hours, and omitted after 6 hours. Keep `age` derivable from `observedAt`; do not bake
   relative strings server-side.
6. Compute `delta1h` only from consecutive valid hourly values and optional NowCast from
   the recent series. Do not smooth or repair missing monitor readings.
7. Return stable compact rows plus summary metadata:

```js
{
  source: 'nyccas',
  observedAt: 0, // newest source observation epoch ms
  rows: [[siteId, name, lat, lon, pm25, observedEpochMin, delta1h, nowcastAqi]],
  fields: 'siteId,name,lat,lon,pm25,observedEpochMin,delta1h,nowcastAqi',
  citation: 'NYC Health + Queens College — NYCCAS',
  stationCount: 0
}
```

Register `makeCachedRoute('/api/air-quality', 600_000, fetchAirQuality, { rows: [] })`.
Ten minutes is responsive enough for an hourly upstream and stays gentle with GitHub.
The cache helper already provides single-flight refresh, last-good data, `fetchedAt`,
`stale`, CDN caching, and graceful empty startup.

Add `airQuality: '/api/air-quality'` to `/api/live`'s `LIVE_FEEDS`. Do not create a new
client poller. Add the same key to `liveBridge.EP` so `#nolive` direct fallback works.

Failure contract: upstream failure serves last-good through the cache; cold failure serves
`rows:[]`. The city continues normally and the control says "air data unavailable". Never
invent fallback numbers.

### Client: `public/index.html`

Add an `airQuality` module after other static point layers and before `function frame()`.
Follow the `nyc311` module for points/chips and `birds`/`citibike` for polling/history.

**Monitor geometry:**
- One `THREE.Points` draw call or one `InstancedMesh`, max 32 slots.
- Convert coordinates only with `subway.geoRaw(lat, lon)`.
- Assert `landOK(x,z)`; skip and warn on a calibration failure. Do not snap monitors to
  streets — they represent actual monitor positions.
- Beacon at low height with a restrained vertical glow. Color by current concentration or
  NowCast category, but label which metric controls the color.
- Stale-but-usable readings pulse less and appear desaturated; never silently look live.

**Chips and focus:**
- Pool at most four `.fybl.airq` chips and distance-rank them like 311.
- Headline: `BQE · 12.4 µg/m³`.
- Expanded detail: `PM2.5 · +2.1 in the last hour · measured 38 min ago · NYCCAS`.
- Click calls `setFocus('air-quality monitor (NYCCAS)', name, data)` and
  `focusui.enter(...)`; data includes measurement, units, timestamp, trend, AQI only when
  valid, and `estimated:false`.
- Apply the canvas-mirror projection formula and Iron Rule 6 (`display='block'`).

**Control and summary:**
- Add `#aqBtn` inside `#hud` after `#vitals`; visible on desktop and mobile even though
  City Vitals itself hides below 900 px. Keep it reachable above GBA controls/safe areas.
- Button states: `AIR QUALITY`, `AIR QUALITY ON`, `AIR DATA UNAVAILABLE`, and historical.
- Toggling controls beacons, field, legend, chips, and summary as one layer.
- Add a compact `#aqLegend` card with PM2.5 ramp, units, measured/estimated keys, newest
  observation time, station count, and source link. In replay, say `RECORDED <date/time>`.
- Hide control/card/chips in photo mode; hide chips in focus mode using existing patterns.
- Add `window.__airQuality` with `{ update, hist, setVisible, rows, _dev }` for testing.
- Call `airQuality.update(T, dt)` in `frame()` near `nyc311.update`.

## Phase 2 — citywide estimated surface

### Offline baseline artifact

Add a script under `scripts/` that:

1. Downloads/reads the approved PM2.5 NYCCAS raster and verifies CRS/year.
2. Samples centers on a regular 500 m geographic grid covering all five boroughs.
3. Converts each center through the exact frozen bake calibration, not a re-derived map.
4. Keeps only `landOK` cells; if the offline script cannot call the browser mask, read the
   authoritative baked mask using the same transform and prove parity against known points.
5. Emits compact metadata and cells: source year, pollutant, units, grid size, and
   `[lat,lon,baseline]` or a packed binary equivalent. Target well under 100 KB compressed.
6. Includes deterministic counts/checksum so later source updates are reviewable.

### Live field model

Do not interpolate raw monitor values across NYC. Preserve the long-term spatial pattern
and interpolate only live departures from it:

```text
residual_i(t) = observed_i(t) - baseline(site_i)
field(x,t) = max(0, baseline(x) + weightedResidual(x,t))
```

Use inverse-distance weighting with safeguards:
- nearest 3–5 fresh stations;
- distance floor about 250 m so one cell cannot explode;
- maximum influence radius 5 km;
- stale readings receive reduced weight;
- no valid monitor in radius: apply only a robust citywide residual (median), mark low
  confidence; do not extend one highway spike borough-wide;
- expose nearest-monitor distance and effective sample count as confidence metadata.

This is a visualization estimate, not an official exposure model. Put the exact algorithm,
parameters, baseline year, and source in the legend's info disclosure and changelog.

### Field rendering

- One instanced low hex/disc/column per retained land cell; do not use `pushPoly`.
- Keep it 15–40 scene meters above ground with transparent, depth-aware material so roads,
  residents, and buildings remain legible.
- One draw call preferred, two maximum (field + uncertainty texture).
- Opacity encodes confidence, not concentration; color encodes concentration. Optional
  subtle stipple/noise marks low confidence without suggesting physical smoke particles.
- The layer must not mutate global fog, sky, weather, or building materials. Spatial
  differences disappear if global fog changes.
- Recompute colors only when data/metric changes, not every frame. Update only camera-facing
  labels per frame.
- Tiering: high/medium use full grid; low tier subsamples cells or uses a coarser baked grid.
  Measure GPU memory and draw calls with `__perfReport()`.

## History recorder and replay

Iron Rule 5 applies in the first implementation, even if hourly scheduling is postponed.

Update both `api/record.js` and `scripts/record.mjs`:
- Fetch `/api/air-quality` alongside existing feeds.
- Store compact rows as `airQuality` and add the schema string.
- Include source observation epoch so a snapshot never makes an old reading look current.
- Add count output for recorder diagnostics.

Client lifecycle:
- `update()` polls only when `!HIST.active`.
- A poll resolving during scrub must not overwrite replay.
- `hist(rows)` renders recorded values and changes legend/badge to recorded.
- `hist(null)` clears replay state, schedules immediate live refresh, and restores the
  latest live rows without manufacturing deltas.
- Pre-air-quality snapshots replay an empty air layer with "not recorded" rather than
  showing present-day values over the past.

Current Vercel cron captures one daily snapshot. Do not promise animated hourly history
until an hourly/15-minute job is actually configured. The local recorder already supports
quarter-hour frame paths, but the current history endpoint/manifest serves daily snapshots;
expanding it is a separate reviewed workstream.

## Optional Phase 3 — Concierge integration

After the visual layer is stable, add a read-only `air_quality` tool in `lib/agent-core.js`:
- nearest monitors to a point/area;
- min/max/median measured PM2.5;
- measured versus estimated explicitly;
- freshness and source in every result;
- no medical advice beyond quoting EPA categories/recommendations.

The tool should read the normalized server feed or a shared fetch helper rather than parse
upstream CSV independently. It may emit a camera intent/highlight for a selected monitor,
but must not expose Google data or represent interpolation as measurement.

## Testing protocol

### Server and data tests

1. Syntax gate: `node -e "require('./lib/api-core.js')"`.
2. Unit-test CSV quoting, CRLF/BOM, bad values, missing stations, UTC parsing, duplicate
   rows, stale thresholds, out-of-NYC synthetic rows, and partial station outages.
3. Unit-test NowCast weighting, `max=0`, missing latest hours, and every 2024 breakpoint.
4. With local server: `/api/air-quality` returns finite compact rows, known NYC locations,
   valid units/timestamps, no synthetic DEC-average point, and an honest station count.
5. `/api/live` includes identical air-quality data and `#nolive` direct mode still works.
6. Simulate upstream failure: last-good persists; cold start becomes empty; no crash.

### Browser and visual tests

1. Cache-bust every reload and check `window.__moduleError` first.
2. Verify all-five-borough placement against known sites; no beacon/field cell on water.
3. Confirm mirror-correct chips and click targets from east/west camera angles.
4. Compare a minimum, median, elevated, stale, and unavailable reading via `_dev`.
5. Verify measured beacons remain visually distinct from estimated cells at every zoom.
6. Check desktop, phone portrait, phone landscape, photo mode, focus mode, and agent panel.
7. Toggle repeatedly: no leaked DOM nodes, geometries, materials, or duplicate polling.
8. Enter/exit history: no live overwrite while scrubbed; old snapshots say not recorded.
9. Smoke counts from `AGENTS.md`: personas ≈12.7k, traffic >10k, street match works.
10. Performance: compare FPS, draw calls, geometry count, JS heap, and GPU estimate with
    layer off/on on high and low tiers. Target <=2 new draw calls and no per-frame allocation.

### Scientific/UX review

- Cross-check latest displayed readings against the NYC Health dashboard.
- Confirm source citation is always reachable while the layer is visible.
- Ask a nontechnical reviewer to identify which values are measured vs estimated without
  explanation; if they cannot, the design fails.
- Avoid asserting causal explanations (traffic caused this spike) from correlation alone.
- During an extreme event, verify scale does not clamp all cells into the same color and
  stale monitors cannot appear current.

## Changelog and documentation

Add a top entry to `CHANGELOG.md` in house format. Credit NYC Health and Queens College,
link the dashboard/data repository, state the baseline raster year, explain measured vs
estimated, note hourly cadence/preliminary status, and say exactly what timeline history is
available. Do not claim "real-time block-level sensors" or "official AQI everywhere."

Update `AGENTS.md` layout/run notes only if new generated artifacts, scripts, or test hooks
need future-agent documentation. Do not add secrets; NYCCAS is keyless.

## Non-goals

- No Google Air Quality heatmap/current-condition map layer.
- No PurpleAir in Phases 1–2.
- No global fog changes tied to PM2.5.
- No medical diagnosis, personalized exposure score, or guarantee of safety.
- No causal attribution of pollution to a road, building, airport, or policy.
- No raw annual GeoTIFF in the browser.
- No new npm dependency or build step for the runtime app.
- No silent interpolation presented as measurement.
- No hourly-history promise without recorder scheduling and history endpoint support.

## Acceptance criteria

- The user can toggle one coherent air-quality layer on every device.
- Every active NYCCAS monitor lands at its calibrated location and displays current PM2.5,
  units, age, trend, and source; stale/unavailable states are obvious.
- The estimated citywide field, if Phase 2 ships, covers land in all five boroughs, renders
  nothing on water, preserves the approved NYCCAS baseline, and visibly communicates
  confidence and estimation.
- A single hourly concentration is never mislabeled AQI; NowCast appears only when EPA
  completeness and formula requirements pass.
- Layer off preserves current visuals/performance; layer on stays within the agreed draw,
  memory, and mobile budgets.
- Live polling obeys `HIST`; both recorders include the field; old snapshots degrade
  honestly; replay never mixes current data into the past.
- Source citation and timestamp remain visible/reachable, and the changelog describes the
  limits without marketing overclaim.
- Upstream failure, empty data, malformed rows, and station outages never crash the city.

## Expected diff surface

Phase 1:
- `lib/api-core.js`
- `public/index.html`
- `api/record.js`
- `scripts/record.mjs`
- `CHANGELOG.md`
- tests using the repo's existing test convention (inspect before creating)

Phase 2 additionally:
- one offline bake script under `scripts/`
- one compact generated PM2.5 baseline artifact under `public/`
- provenance/checksum documentation if not embedded in the artifact

Phase 3 optionally:
- `lib/agent-core.js`

Before editing shared `public/index.html`, pull/rebase safely, inspect other agents' work,
stage explicit files only, and visually verify before any push. A push to `main` deploys.
