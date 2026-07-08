# Task: Street-speed intelligence — concierge support + real-speed traffic in the 3D scene

*(replaces the completed backend-migration plan that previously lived in this file; that work
shipped long ago — see git history)*

## Context — what already exists (do not rebuild)

Three provenances of measured street speed are live in the codebase (section 25g of
`public/index.html` + `lib/api-core.js`), each labeled honestly in its UI chips:

| Feed | Route | What | Freshness | Coverage |
|---|---|---|---|---|
| DOT highway sensors | `/api/traffic` (also in `/api/live` snapshot) | per-link mph + travel time | LIVE, 60 s | ~60 links: FDR, WSH, BQE, Bruckner, bridges, tunnels |
| E-ZPass local readers | `/api/traffic-local` and `/api/traffic-local/:day` | per-link **24-hour mph profile** for a published day | daily batches, **~2 days behind** | ~290 links on NORMAL streets, 137 in Manhattan |
| Bus probes | client-only (`rtraffic` module, `PRB`) | moving buses aggregated per street edge, rolling 10-min window | LIVE | wherever ≥2 buses moved recently |
| 511NY incidents/closures | `/api/traffic-events` (in `/api/live`) | filtered real events | LIVE, 3 min | citywide bbox |

Key semantics the whole plan leans on:
- The E-ZPass client layer colors links by the profile hour matching the **viewed wall clock**
  (timeline thumb) — Live shows "recent typical", a replayed published day shows real
  measurements. `EZ.shown` in `rtraffic` holds `{ day, hh, links }` currently displayed.
- Bus probes are live-only (cams precedent). `rtraffic` exports `ez` and `probes` for testing.
- Neighborhood + borough boundaries exist since 9347a4e and the concierge already uses them
  for Focus context — traffic answers can and should be neighborhood-aware.

## The use cases (acceptance scenarios)

Workstreams below exist to make these real. ★ = hero cases; test these end-to-end.

**Superlatives & ranking (concierge)**
- ★ "What's the slowest local street in the West Village right now?" → filter E-ZPass links
  by neighborhood boundary, sort by current-hour mph ascending, pin the winner on the map.
- "Where's the worst congestion in Manhattan?" → top-10 slowest links, mapped red.
- "Rank neighborhoods by how bad traffic is" → aggregate links per neighborhood boundary.

**Temporal / profile (concierge — unique to this dataset)**
- ★ "When is 6th Ave worst?" / "Best time to drive up 2nd Ave?" → one link's 24 h profile,
  name the trough/peak hour with the mph numbers.
- ★ "Show me the Midtown grid filling up through the morning" → `set_timeline` scrubs; the
  E-ZPass ribbons already recolor by viewed hour — the agent narrates + drives the scrub.

**Live-vs-typical divergence (concierge — needs both signals)**
- ★ "Is traffic worse than usual right now?" → live DOT highway mph (and/or bus speeds
  `near` an area) compared against E-ZPass typical-for-this-hour; report the divergence.
- "Something feels off on the West Side Highway" → live DOT vs recorded snapshot same-hour.

**Cross-feed (concierge)**
- "Cab or subway from SoHo to Times Square right now?" → E-ZPass along the cab corridor vs
  live subway feed. Answer link-level, never invent an end-to-end ETA (no routing engine).
- "Fly me to the worst jam in the city" → slowest live link → `set_camera` + pin.

**Ambient realism (3D scene — Workstream B)**
- ★ A viewer at street level sees cars crawl on streets the data says are jammed and flow
  freely where it says they're moving — including while scrubbed into a replayed day.
- Buses already move at real GPS speeds (live feed); cars are the gap.

**Playful (cheap once the above lands — prompt-only)**
- "Quietest street to film on at 6 AM" (profile at hour 6, ascending).
- "Rate my commute" (score the user's described corridor+hour against profiles).

## Workstream A — concierge support (`lib/agent-core.js` only)

The agent's `readFeed()` already reads the in-process `routes` map, so
`readFeed('/api/traffic-local')` works today. Changes:

1. **New `FEEDS.traffic_local` entry.** Rows:
   `{ label: '<name> · <mph> mph', name, borough, speedMph, lat, lon, id }` — `speedMph`
   evaluated at the current NY wall-clock hour (`Intl.DateTimeFormat` h23, same as the
   client's `viewedHour`), lat/lon = link midpoint. `search` on name+borough. `summary` =
   `{ publishedDay, linksTotal, avgSpeedMphByBorough }`. Existing machinery then gives
   `sort_by: speedMph`, `near`, `top`, `show_layer` pins, `spatial_report` for free.
2. **`hour` and `day` params on `get_data`** (special-case in `feedQuery` like subway):
   - `hour` (0–23): evaluate rows at that profile hour instead of now.
   - `day` (YYYY-MM-DD): serve from `trafficLocalByDay(day)` (export it from api-core).
     Answers "how was 6th Ave last Friday". Unpublished day → the endpoint's error note;
     the agent must relay it, not improvise.
   - When ≤5 rows survive filtering, attach each row's full `profile` (24 mph values) so
     "when is this street worst" is one tool call.
3. **System-prompt additions** (keep to ~4 lines, match existing voice):
   - E-ZPass = reader medians published ~2 days behind → always present as
     "typical for this hour (published <day>)", never as live.
   - Live local recipe: for "right now" on local streets, read `buses` with `near` +
     `sort_by speedMs` and report average moving bus speed as the live signal.
   - Divergence recipe: compare live DOT / bus speeds against `traffic_local` same-hour to
     answer "worse than usual?".
   - Neighborhood questions: resolve the boundary first (existing mechanism), then `near`.
4. **Testing:** unit-test `feedQuery({feed:'traffic_local', ...})` shapes via `node` (hour,
   day, filter→profile, sort). One end-to-end gateway round-trip per ★ concierge case above
   (needs `ai-gateway-key.json`, present locally). Log-check no schema-validation rejects.

## Workstream B — real-speed cars in the 3D scene (`public/index.html`)

Goal: the ambient simulated cars (section 22 `traffic` module) move at data-informed speeds.
Buses need nothing — they are real vehicles at real speeds already.

**Design: a shared speed field, owned by `rtraffic` (25g), consumed by section 22.**

1. **Build the field** in `rtraffic`: a `Map` of 150 m grid cells → `{ mph, w }` (weight by
   provenance: bus probe (live) > DOT link (live) > E-ZPass (typical-at-viewed-hour)).
   Rebuild whenever any sub-layer rebuilds (all already have rebuild points: `ingestLinks`,
   `ezRebuild`, `prbRebuild`). Expose `rtraffic.speedAt(x, z)` → mph | null (one hash lookup,
   no allocation). Populate cells by walking each link/edge polyline at ~75 m steps.
2. **Consume in section 22 — RESPECT PERF E:** the traffic sim is now distance-tiered; do
   not add per-car-per-frame work beyond one cheap lookup, and refresh on the existing tier
   stride, not every frame. Per vehicle keep a `spdK` factor (default 1), updated when the
   car crosses a grid cell or on the stride: `spdK = clamp(mph / kindTypical, 0.15, 1.3)`
   with `kindTypical` ≈ 45 mph hwy/bridge, 17 mph ave, 11 mph st (tune visually). Apply as a
   multiplier on the existing `wave` speed term; where `speedAt` is null keep today's
   synthetic behavior unchanged.
3. **Brake lights for free:** feed `1 - spdK` into the existing `aBrake` attribute path so
   jammed streets read as walls of red at night.
4. **History:** the field already follows the viewed hour/replayed day (E-ZPass layer) and
   recorded DOT speeds (hist rows) — cars in a replayed day automatically crawl where that
   day's data crawled. Probes contribute nothing while scrubbed (already cleared).
5. **Verification:** `window.__rtraffic.speedAt` spot checks against a visibly jammed link;
   screenshot a red-ribbon street and confirm cars visibly slower than on a green one; fps
   check per PERF.md protocol (no regression at street tier); `__moduleError` clean;
   scrub to a published day and confirm car speeds change with the viewed hour.

**Parallel-work rules (AGENTS.md):** section 22 was just rewritten by Perf E — read it fresh
before editing, keep the diff to the speed-factor hook, `git pull --rebase` before push, and
do not touch calibration/land predicates. If the section-22 hook can't stay surgical, stop
and ask the user.

## Workstream C — additional realtime sources (probed 2026-07-08; DECIDE TOGETHER)

| Source | Verdict | Notes |
|---|---|---|
| **HERE Traffic Flow API** | ✅ **best candidate — recommend** | Real-time speed + jam factor for **all mapped streets** in one bbox call. Free tier 250k txn/mo; Manhattan bbox every 2 min ≈ 22k/mo. Needs a free key (git-ignored file, `mta-bus-key.json` pattern). Attribution required. Would make "live on ANY local street" real instead of bus-probe-approximate, and slots into the speed field as a 4th (top-priority) provenance. |
| TomTom Flow Segment | ⚠ feasible, weaker | Free ~2.5k req/day but **per-point** queries → only ~50 curated street points at 30-min cadence. Key required. HERE strictly dominates it. |
| 511NY link speeds | ❌ | No such public endpoint (probed: 404). Events only. |
| 511NY `getmessagesigns` | ✅ works keyless (200) | Not speeds — live VMS sign texts. Cute optional layer ("what do the highway signs say right now"), zero urgency. |
| Waze live-map georss | ❌ unofficial | 403 from server; ToS-gray, unstable. Skip. |
| PANYNJ crossing times | ❌ | Legacy XML endpoint dead (404). |
| TRANSCOM / Waze CCP | ❌ | Partnership agreements required. |

**Decision needed from the user:** sign up for a free HERE key? If yes, add Workstream D:
`/api/traffic-here` (bbox flow, ~120 s TTL, normalized to the existing link contract), fold
into the speed field at top priority, teach the concierge, and record a compact per-cell
summary in the daily snapshots (HERE data is ephemeral → must be recorded, unlike E-ZPass).
Roughly half a day. Everything in A and B works without it.

## Non-goals

- No routing engine / door-to-door ETAs (agent answers stay link-level and say so).
- No recorder changes for E-ZPass (the published archive IS the recording) or bus probes
  (live-only) unless HERE lands.
- Do not renumber sections; do not touch frozen calibration or land/coast predicates.

## Suggested order

1. Workstream A (concierge) — independent, immediately demo-able via the ★ questions.
2. Workstream B (speed field + cars) — the visible wow; touches shared section 22, so
   coordinate before starting per AGENTS.md.
3. Workstream C decision → optional Workstream D (HERE).
