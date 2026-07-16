# Plan: Monitor NYCCAS GitHub and always serve the freshest air-quality observations

Audience: a coding agent joining this repository. Read `AGENTS.md` and
`plan-air-quality.md` before editing. This document is an implementation plan for owner
review, not authorization to commit, deploy, or publish. Reconfirm all symbols and line
ranges because this repository is edited concurrently.

---

## Goal

Make `/api/air-quality` reliably follow changes in
`https://github.com/nychealth/nyccas-data`, select the newest valid observation available
from NYC Health's portal and monthly archive files, expose enough provenance to explain
exactly what was served, and detect source stalls or schema changes without replacing good
data with an empty response.

The result must satisfy four user-visible guarantees:

1. If NYC Health publishes a newer valid observation in either supported CSV, NYC SIM
   serves it after the next successful refresh.
2. A delayed publication is shown with its real observation age; it is never described as
   a sensor connectivity failure.
3. The API states which upstream file supplied the result, when that file was retrieved,
   and the newest observation found in every checked source.
4. A malformed, unavailable, or late source cannot erase the last successful dataset.

"Freshest" means the greatest normalized UTC observation timestamp from a valid official
source. It does not mean the time at which NYC SIM downloaded the file.

## Non-goals

- Do not scrape rendered HTML from the NYC Health dashboard.
- Do not claim that repository commits are sensor transmissions.
- Do not query individual physical sensors.
- Do not turn the monthly archive into timeline playback; the existing recorder remains
  the authority for NYC SIM's seven-day replay.
- Do not include the synthetic `DEC Monitor Average` as a map point. It has no real NYC
  coordinate or SiteID in the station file.
- Do not change PM2.5 categories, field interpolation, frozen geography, or land masks.
- Do not add npm dependencies; the server is intentionally zero-dependency Node 18+.

---

## Official upstream files

Repository:

- `https://github.com/nychealth/nyccas-data`

Station identity and coordinates:

- `https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/portal/station-new.csv`
- Shape: `SiteID,Location,loc_col,Latitude,Longitude`
- `SiteID` is the canonical join key. `loc_col` joins portal `SiteName` values to SiteID.

Dashboard-oriented rolling feed:

- `https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/portal/view.csv`
- Shape: `SiteName,Operator,starttime,timeofday,Value`
- This is the file loaded by NYC Health's public dashboard.
- It has convenient recent history and may publish newer rows before the monthly archive.

Monthly archive:

- Pattern:
  `https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/hist/csv/YYYY/M.csv`
- Example for July 2026:
  `https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/hist/csv/2026/7.csv`
- Shape: `ID,SiteID,ObservationTimeUTC,Value`
- Month is not zero-padded.
- `ObservationTimeUTC` is explicitly UTC in the repository documentation.

Public presentation and source implementation:

- Dashboard:
  `https://a816-dohbesp.nyc.gov/IndicatorPublic/data-features/realtime-air-quality/`
- Dashboard source:
  `https://github.com/nychealth/EH-dataportal/blob/production/content/data-features/realtime-air-quality/js/realtime.js`

Known upstream caveat: the repository README labels archive timestamps UTC, while the
portal/dashboard presents `starttime` as Eastern Standard Time. Do not compare the raw
strings or infer freshness from filenames. Normalize both formats before selection.

---

## Current implementation and failure mode

The authoritative backend is `lib/api-core.js`:

- `NYCCAS_STATIONS` points to `portal/station-new.csv`.
- `NYCCAS_VALUES` points only to `portal/view.csv`.
- `fetchAirQuality()` parses the portal file, groups by station, derives one-hour change and
  NowCast, and returns compact rows.
- `/api/air-quality` uses `makeCachedRoute` and participates in `/api/live`.

The frontend air-quality module in `public/index.html` consumes
`liveBridge.get('airQuality')`, rebuilds measured beacons, and labels observations by age.
`api/record.js` and `scripts/record.mjs` persist the compact rows unchanged.

A previous failure mode rejected the refreshed dataset when all newest observations were
older than an arbitrary age threshold. The cached-route helper then correctly retained
last-good data, but the API could remain pinned to an older source snapshot even though a
newer delayed observation existed upstream. The implementation must never use observation
age as an ingestion rejection criterion. Age is presentation and monitoring metadata.

---

## Product decisions

1. Treat both `portal/view.csv` and the monthly archive as official candidate sources.
2. Prefer observations, not files: merge valid rows by canonical SiteID and normalized UTC
   timestamp, then select the newest row per station.
3. For the same SiteID and timestamp, prefer the monthly archive record because it has an
   explicit SiteID and UTC field. Retain portal provenance when the archive has not caught
   up.
4. Fetch the current UTC month and previous UTC month. This prevents a gap around midnight
   and month rollover when the new monthly file does not exist yet.
5. Keep the portal rolling feed because it powers the official dashboard and can be ahead
   of the archive.
6. Refresh source data at most once per minute per warm backend instance. The source itself
   is hourly, so a shorter upstream interval adds load without improving observations.
7. Monitor file content and newest observations. Git commit activity is supplemental
   provenance, not the freshness authority.
8. Preserve the existing compact row schema so the frontend and recorded snapshots remain
   backward compatible.
9. Add top-level provenance fields to the API response; do not append fields to each compact
   row unless all recorder and replay consumers are migrated together.

---

## Canonical data model

Normalize both CSVs to an internal object before merging:

```text
{
  siteId: string,
  name: string,
  lat: number,
  lon: number,
  value: number,
  observedAt: number,       // UTC epoch milliseconds
  source: "portal" | "archive",
  sourceRowId: string | null
}
```

Validation:

- `siteId` must exist in valid station metadata.
- Latitude and longitude must be finite and inside the existing broad NYC bounds.
- PM2.5 must be finite and `0 <= value <= 1000`.
- `observedAt` must be finite.
- Reject observations more than 15 minutes in the future after normalization.
- Do not reject observations for being old.
- Drop malformed rows individually; reject a source only when its schema is invalid or it
  yields no usable rows.

Deduplication key:

```text
siteId + ":" + observedAt
```

Conflict handling:

- If duplicate keys have values equal within `0.01 µg/m³`, retain one canonical row and
  record both contributing sources in source statistics.
- If duplicate keys disagree by more than `0.01`, prefer the archive value, increment a
  `conflictCount`, and emit one bounded structured warning per refresh. Do not log the full
  CSV or every disagreement.

Latest selection:

- Select the greatest `observedAt` independently for every SiteID.
- `observedAt` at the API top level is the greatest selected station timestamp.
- A station that has not reported as recently as others remains present with its own real
  timestamp and frontend freshness state.

NowCast and hourly delta:

- Build each station's sorted history from the merged, deduplicated observations.
- Calculate delta and NowCast from canonical UTC timestamps, not CSV row order.
- Preserve the existing NowCast completeness and weighting rules unless separate review
  finds them incorrect.

---

## Timestamp normalization

### Archive

Parse `ObservationTimeUTC` by extracting numeric date/time components and passing them to
`Date.UTC`. Do not use locale-dependent `Date.parse`.

### Portal

Before changing production behavior, prove the portal convention with an automated overlap
comparison:

1. Join portal `SiteName` to SiteID through `station-new.csv`.
2. Choose at least 24 overlapping hours from portal and archive data.
3. Evaluate candidate interpretations of portal `starttime`: UTC, UTC-4, and UTC-5.
4. For each candidate, compare `(SiteID, normalized timestamp, Value)` against archive rows.
5. Require one interpretation to match at least 95% of overlapping rows within `0.01`.
6. Encode the proven interpretation explicitly and save the overlap sample as test fixtures.
7. If no candidate reaches the threshold, fail the source refresh with a schema/timestamp
   diagnostic and retain last-good data. Do not silently guess.

Expected initial hypothesis: the portal is dashboard-oriented Eastern time and the archive
is UTC. The coding agent must confirm whether the portal uses fixed EST or daylight-aware
America/New_York semantics for July 2026 before replacing `nyccasTime()`.

Runtime should use the proven deterministic parser, not rerun offset inference on every
request. Keep the overlap verifier as a test/diagnostic utility that can be rerun when the
source schema changes.

Required timestamp tests:

- A July fixture that distinguishes UTC-4 from UTC-5.
- A January fixture.
- DST spring-forward and fall-back boundaries if the portal is proven daylight-aware.
- Month and year rollover.
- A future timestamp rejection.
- A delayed but valid observation acceptance.

---

## Source URL discovery and month rollover

Create a pure helper that returns archive candidates from a supplied UTC epoch:

```text
archiveUrls(now) -> [currentMonthUrl, previousMonthUrl]
```

Examples:

- July 16, 2026 -> `2026/7.csv`, then `2026/6.csv`
- August 1, 2026 -> `2026/8.csv`, then `2026/7.csv`
- January 1, 2027 -> `2027/1.csv`, then `2026/12.csv`

Behavior:

- A `404` for the current month is expected during rollover and is not fatal if another
  candidate succeeds.
- Fetch previous month even when current succeeds so the NowCast window and stations whose
  newest report crossed the boundary remain complete.
- Limit archive fetching to those two months. Do not download the full historical tree.
- Continue fetching `portal/view.csv` independently.

---

## Fetching and cache behavior

Implement one reusable `fetchNyccasCsv(url, sourceName)` helper:

- Use `AbortSignal.timeout(10_000)`.
- Send `User-Agent: manhattan-island-city-twin`.
- Send `Cache-Control: no-cache` and `Pragma: no-cache`.
- Set fetch `cache: "no-store"`.
- Append a minute-bucket cache-busting query parameter to raw GitHub URLs.
- Capture response `ETag`, `Last-Modified`, status, byte length, and retrieval timestamp.
- Read text once, calculate SHA-256 with built-in `node:crypto`, then parse CSV.
- Enforce a reasonable maximum payload size before parsing, with a documented threshold
  comfortably above the present monthly file.
- Treat HTML, empty bodies, missing required headers, and Git LFS pointer text as failures.

Route cache:

- Keep `/api/air-quality` TTL at 60 seconds.
- Preserve `ensureFresh` single-flight behavior so concurrent requests share one refresh.
- Preserve last-good serving on refresh failure.
- Do not let CDN stale-while-revalidate obscure provenance: `fetchedAt` must always mean the
  successful backend source refresh represented by the payload, not edge response time.
- `/api/live` may continue its 15-second consolidation cadence; it must pass all new
  top-level air-quality provenance fields through unchanged.

Do not request GitHub's commits API every minute. Unauthenticated API access has a small
rate limit and commit time is not observation time. If commit metadata is desired, fetch it
no more than every 10 minutes, use conditional `ETag` requests, and degrade without it.

---

## Change monitoring

Maintain per-source monitoring state in the air-quality fetcher result:

```text
sources: {
  portal: {
    url,
    ok,
    fetchedAt,
    newestObservedAt,
    rowCount,
    byteLength,
    contentSha256,
    etag,
    lastModified,
    error
  },
  archiveCurrent: { ... },
  archivePrevious: { ... }
}
```

Also return:

```text
selectedSource: "portal" | "archive" | "mixed"
sourceChanged: boolean
sourceConflictCount: number
sourceLagMinutes: number
```

Definitions:

- `sourceChanged`: at least one successful source content hash differs from the previous
  successful refresh in the same warm instance.
- `sourceLagMinutes`: age of the greatest selected observation at response creation.
- `selectedSource`: `mixed` when latest station rows come from more than one source.

Structured logs:

- On content change:
  `[air-quality] source_changed source=<name> sha=<short> newest=<ISO> rows=<n>`
- On source failure:
  `[air-quality] source_failed source=<name> status=<status> reason=<bounded>`
- On conflict:
  `[air-quality] source_conflict count=<n> preferred=archive`
- On stall threshold crossings, not every minute:
  `[air-quality] source_stalled newest=<ISO> ageMinutes=<n>`
- On recovery:
  `[air-quality] source_recovered source=<name> newest=<ISO>`

Never log full rows, response bodies, tokens, or URLs containing credentials.

Suggested stall levels for operational reporting only:

- `normal`: newest observation age <= 150 minutes
- `delayed`: > 150 and <= 360 minutes
- `overdue`: > 360 minutes

These levels must not reject data. Log only when the level changes to avoid noise.

Persistent monitoring is optional Phase 2. Warm-instance hashes disappear on cold start.
If persistent alerts are required, add a separately reviewed Vercel Cron that stores the
last source hash/newest timestamp in an existing private server-side store and sends an
approved alert. Do not add persistence or notifications to the request path in Phase 1.

---

## API contract

Keep existing fields:

```text
source
observedAt
rows
fields
citation
stationCount
now
fetchedAt
stale
```

Add:

```text
selectedSource
sourceChanged
sourceConflictCount
sourceLagMinutes
sources
```

Semantics:

- `stale` continues to describe whether the backend route refresh failed/expired.
- `sourceLagMinutes` describes observation age even when the fetch itself succeeded.
- A successful fetch of an unchanged file is not stale.
- A successfully fetched source with old observations is delayed/overdue, not failed.
- `fetchedAt` is backend retrieval success time.
- `observedAt` is newest selected measurement time.

Bound `sources.*.error` to a short public-safe code such as `http_404`, `timeout`,
`schema`, or `empty`; keep detailed exception text in server logs only.

Example response shape:

```json
{
  "source": "nyccas",
  "selectedSource": "mixed",
  "observedAt": 0,
  "sourceLagMinutes": 0,
  "stationCount": 14,
  "sourceChanged": true,
  "sourceConflictCount": 0,
  "sources": {
    "portal": {
      "url": "https://raw.githubusercontent.com/.../portal/view.csv",
      "ok": true,
      "fetchedAt": 0,
      "newestObservedAt": 0,
      "rowCount": 0,
      "contentSha256": "..."
    }
  },
  "rows": []
}
```

Do not expose a cache-busting query string as the canonical public source URL.

---

## Frontend behavior

Update only the air-quality module in `public/index.html`:

- Continue polling the consolidated live bridge on the existing one-minute module cadence.
- Store the new top-level provenance without changing compact monitor rows.
- Base each row's `CURRENT`, `DATA DELAYED`, and `UPDATE OVERDUE` state on that row's
  observation timestamp.
- Base `SOURCE REFRESH DELAYED` on API `stale` or all source fetches failing.
- Do not label an unchanged hourly source as a failed refresh.
- Add a concise source line in the existing legend or panel footer:
  `NYCCAS · PORTAL`, `NYCCAS · ARCHIVE`, or `NYCCAS · MIXED`.
- Make the source label a link to the canonical URL selected for the newest observation.
- Keep `CHECKED <time>` as retrieval time and `UPDATED <time>` as observation time.
- If provenance fields are absent in recorded/older payloads, retain current behavior.
- During `HIST.active`, use recorded rows and display `RECORDED`; do not show present-day
  source retrieval metadata.

Do not add a second status panel or expose hashes to ordinary users.

---

## Recorder and history compatibility

`api/record.js` and `scripts/record.mjs` currently store only `airQuality.rows`. Keep that
shape for backward compatibility.

Phase 1:

- No recorder schema migration is required.
- Confirm both recorder paths continue accepting the API response with extra top-level
  provenance.
- Confirm timeline replay sends only compact rows to `airQuality.hist()`.

Optional later migration:

- If provenance needs to survive replay, add an `airQualityMeta` object in a versioned frame
  schema and update both writers and the client reader in one change. Do not overload compact
  row positions.

---

## Recommended code organization

Avoid growing `fetchAirQuality()` into an untestable block. Either extract a focused
zero-dependency CommonJS module such as `lib/nyccas-source.js`, or define pure helpers near
the existing fetcher and export them only under a clearly internal test namespace.

Recommended units:

```text
archiveUrls(nowMs)
parseNyccasUtc(value)
parsePortalTimestamp(value)
parseStations(csvText)
parsePortalRows(csvText, stations)
parseArchiveRows(csvText, stations)
mergeObservations(sourceSets)
buildAirQualityRows(observations)
fetchNyccasCsv(url, sourceName)
fetchAirQuality()
```

Keep network orchestration separate from parsing and merging. Every pure helper should be
testable with tiny inline CSV fixtures and a supplied clock.

Files expected to change in Phase 1:

- `lib/api-core.js`
- Optional new focused helper under `lib/`
- `public/index.html`
- New zero-dependency test script under `scripts/`
- `CHANGELOG.md` only if the user-visible provenance behavior materially changes before
  shipment; update the existing air-quality entry rather than adding a duplicate.

Files to verify but not necessarily change:

- `api/record.js`
- `scripts/record.mjs`
- `api/index.js`
- `server.js`
- `vercel.json`

---

## Tests

Use built-in `node:assert/strict`; do not add a framework.

### Pure parser fixtures

1. Station metadata joins `loc_col` to SiteID and drops `DEC_Avg`.
2. Portal CSV handles CRLF, BOM, quoted values, whitespace, and missing rows.
3. Archive CSV handles `ObservationTimeUTC` and numeric IDs.
4. Invalid PM2.5, coordinates, timestamps, and future rows are dropped individually.
5. Old valid observations are retained.
6. Portal timestamp interpretation matches archive overlap at the required threshold.

### Merge fixtures

1. Portal newer than archive -> portal selected.
2. Archive newer than portal -> archive selected.
3. Different stations newest in different sources -> `mixed`.
4. Same station/time/value -> one deduplicated observation.
5. Same station/time/different value -> archive selected and conflict counted.
6. Missing current-month archive -> portal and previous month still succeed.
7. Missing portal -> archive succeeds.
8. Both live candidates fail -> fetcher rejects so cached-route last-good remains.
9. One station delayed while others are current -> all remain in output with independent
   timestamps.
10. NowCast uses deduplicated chronological history.

### Month URL fixtures

- July -> July + June.
- January -> January + previous December/year.
- Leap-day timestamp.
- Non-zero-padded month.

### Fetch fixtures

Mock `global.fetch` before requiring the module:

- Verify timeout/no-cache/no-store/cache-busting options.
- Verify canonical URLs omit cache-busting query parameters in response metadata.
- Verify `ETag`, `Last-Modified`, byte count, and SHA-256 capture.
- Verify `404` current archive is tolerated.
- Verify oversized, empty, HTML, and schema-invalid bodies fail safely.
- Verify one-minute route TTL.

### Integration checks

Run a clean local server on an unused port and request `/api/air-quality` twice:

- Response has at least one valid station.
- `observedAt` equals the maximum compact-row timestamp.
- `selectedSource` agrees with the per-row source selection calculation.
- `sourceLagMinutes` agrees with `now - observedAt` within rounding tolerance.
- Second request uses the route cache and does not perform duplicate upstream fetches.
- After TTL expiry and an upstream fixture change, response advances to the new observation.
- When upstream fixture fails, the prior response remains and `stale` eventually becomes
  true according to cached-route semantics.

Run syntax and whitespace checks:

```bash
node --check lib/api-core.js
node --check lib/nyccas-source.js
node scripts/test-air-quality-source.js
git diff --check
```

Omit checks for files that are not created.

### Browser checks

In a visible tab, not a hidden preview harness:

- Air-quality panel populates.
- Latest values match the winning official source by SiteID and UTC timestamp.
- Source label and link are correct.
- `CHECKED` advances independently from hourly `UPDATED`.
- Delayed rows remain visible and never say `NO SIGNAL`.
- Timeline mode displays recorded rows and no current provenance.
- `window.__moduleError` remains unset.

---

## Operational verification against production upstream

Before shipping, run a read-only audit that prints only aggregate metadata:

```text
source name
canonical URL
HTTP status
content hash prefix
row count
newest normalized UTC observation
number of valid stations at newest time
```

Then compare at least three SiteIDs across portal and archive overlap. Do not rely on the
first or last physical CSV row because source ordering is not a contract.

Verify the newest production API compact row for each sampled SiteID equals the winner from
the normalized merge. Capture the audit output in the review message, not in committed
files.

At month rollover, manually verify:

- New current-month `404` does not empty the feed.
- Previous month remains available.
- When current month appears, the next successful refresh incorporates it.

---

## Rollout

1. Implement pure parsers, timestamp tests, archive URL discovery, and merge tests.
2. Run the overlap verifier and get owner confirmation of portal timezone interpretation.
3. Add dual-source fetch and provenance behind an environment-controlled kill switch such
   as `NYCCAS_DUAL_SOURCE !== "0"`, defaulting on only after tests pass.
4. Verify `/api/air-quality` locally against current upstream.
5. Verify `/api/live` passes provenance through.
6. Verify recorder compatibility and browser states.
7. Update the existing changelog entry if needed.
8. Commit only explicitly reviewed files.
9. Deploy to preview first and compare preview API results with both official CSVs.
10. Promote only after owner review.

Recommended rollback:

- Set the kill switch off to use portal-only parsing while retaining provenance and the
  corrected no-age-rejection behavior.
- If a code rollback is required, preserve the fix that accepts delayed observations; do
  not restore the old stale-row ingestion cutoff.

---

## Acceptance criteria

Implementation is complete only when all are true:

- `/api/air-quality` evaluates portal, current-month archive, and previous-month archive.
- Portal/archive timestamps are normalized according to a proven, tested convention.
- The newest valid observation per station wins regardless of file.
- Delayed observations are retained.
- Partial source failures do not empty the result.
- Both-source failure serves cached last-good data through existing route behavior.
- Month/year rollover tests pass.
- Response exposes bounded provenance and observation lag.
- Content changes and source state transitions produce bounded structured logs.
- Existing compact rows, recorder snapshots, and timeline replay remain compatible.
- Frontend accurately distinguishes observation age from backend retrieval status.
- Current production values match the normalized official source winner for sampled
  SiteIDs.
- No external dependency, secret, new geography path, or water-placement behavior is added.
- Owner reviews the diff and evidence before any publish or production deployment.

## Owner decisions required before implementation

1. Approve dual-source selection (`portal` + monthly archive) rather than portal-only.
2. Approve archive-preferred conflict resolution for identical SiteID/timestamp conflicts.
3. Confirm whether top-level provenance should be public in `/api/air-quality` or reduced to
   source name/timestamps only.
4. Decide whether persistent stall alerts are needed after Phase 1 and, if so, where they
   should be delivered.
5. Approve the empirically proven portal timezone interpretation before production parsing
   changes.
