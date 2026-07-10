# Task: Resident thought bubbles — Sims-style thoughts over the PUMS crowd

Audience: a coding agent joining this repo. Read `AGENTS.md` first — the Iron Rules
(frozen calibration, `landOK` water gating, the mirror, parallel-work discipline) all apply.
Anchors below were verified against the working tree on 2026-07-10; line numbers drift —
re-verify with grep before editing. A parallel agent is working `plan.md` (street speeds);
this plan touches different files but the same `public/index.html`, so rebase carefully.

---

## For the non-technical reader: what is this and how will it work?

**What we're doing.** The city already has 12,703 tiny walking residents — each one is a
real, anonymous person from the US Census (about 1 figure for every 650 actual New
Yorkers, so the crowd genuinely mirrors the city: its ages, jobs, incomes, languages,
neighborhoods). Right now you can click a resident to read who they are. This project
gives them an inner life: when you zoom in close, a handful of residents at a time will
show a small **thought bubble over their head, Sims-video-game style** — a cloud with an
icon (🚇 💸 ☔ 💼 …), and if you hover or zoom in further, a short one-line thought.

**What the thoughts will say.** Two kinds, blended:

1. **Reactions to the real city, right now.** The scene already tracks live NYC data —
   actual weather, actual subway delays. If it's genuinely raining in New York, umbrella
   thoughts ripple through the crowd. If the F train is really delayed, commuters who
   ride the F grumble about it. Nothing is faked; the crowd reacts to the same live city
   you're looking at.
2. **Thoughts about their own lives.** Written by an AI that reads each resident's real
   census profile (a 43-year-old nurse from Queens who commutes by subway thinks
   differently than a retired teacher on the Upper West Side) and writes a short,
   in-character thought for each of them — e.g. *"night shifts pay the rent, barely."*
   These are pre-written in a nightly batch, so showing them costs nothing while you
   browse.

**What it will NOT do.** Residents stay anonymous — no names, ever (they're real census
respondents; anonymity is a feature of this project, not a limitation). Thoughts never
appear when you rewind the city with the time slider (they're a "live" feature only, so
they can never contradict the past weather you're looking at). And the crowd's appearance
never encodes demographics — that stays true for thoughts too: the bubble is what they
think, not a costume.

**How it gets built, in plain terms — three steps:**

1. **Step 1 (no AI needed):** the bubbles themselves — icon clouds that appear over a
   rotating handful of on-screen residents when zoomed in, with thoughts generated
   instantly on your device from each resident's profile plus the live weather/subway
   state. Ships first; already feels alive.
2. **Step 2 (the AI batch — one time):** we run a script once that asks a fast AI model
   to write a few personal thoughts for every one of the 12,703 residents, and save the
   whole "thought sheet" as a data file inside the app itself — just like the census data
   already is. One-time cost of roughly **$2–3, then $0 forever**; there is no nightly
   job, no cloud storage, and nothing to maintain. The thoughts are written to be
   timeless (about who each person is, not about today's weather), so they don't go
   stale — and the live reactions from step 1 keep the crowd feeling current. If we ever
   want fresh thoughts, we just run the script again.
3. **Step 3 (on-demand):** click a resident and press *"💭 what's on their mind?"* — a
   single live AI call writes a fresh thought grounded in this exact moment (today's
   weather, right-now delays), and the City Concierge chat learns what that resident was
   thinking so you can ask follow-up questions about them.

If anything is unavailable — no thought sheet yet, no AI key configured — the bubbles
quietly fall back to the simpler built-in thoughts. Nothing breaks.

---

## Goal (technical)

Sims-style thought bubbles over the §25h PUMS voxel walkers: icon-first cloud bubbles on
a rotating, spread-apart set of ≤8 on-screen residents when zoomed in and **not** in
history mode; text on hover/close zoom; a plumbob marker over the focused resident.
Thought content = client-side seeded generator (identity + live-data reactive) blended
with a **one-time** LLM-baked "thought sheet" shipped as a static asset (zero running
cost), plus one user-initiated live call per click. Polling the crowd (PUMS-weighted
survey engine) is **parked** — do not build it.

## What already exists (do not rebuild)

| Piece | Where | Contract |
|---|---|---|
| 12,703 PUMS walkers | `public/index.html` §25h (`const personas = …`, ~line 7323) | 8 InstancedMeshes; walk cycle 100% vertex-shader (`iSeg`/`iWalk` + `uTime`); `PEOPLE[]` rows `{x,z,w,kid,ci,p,area,rep,ax,az,dx,dz,ph,spd,len}` |
| Live CPU position of a walker | `posAt(pp)` in §25h | mirrors the shader ping-pong exactly — anchor bubbles here |
| Distance-grow scale | shader: `clamp(distance(walkOrg, cameraPosition)/900, 1, 4)` | bubble y-offset must multiply head height (~7.4 m) by the same factor |
| Persona fields | `public/personas.json` `meta.fields` | `pumaId,age,isFemale,raceIdx,originIdx,langIdx,eduIdx,occIdx,incomeThousands(-1=NA),commuteIdx,status` + lookup tables + `repPer` |
| Persona card + focus | §25h `open(pp)` → `#personaCard`, `setFocus(...)`, `focusui.enter(...)` | click-picking pattern already handles moving walkers |
| Screen-anchored HTML chips | cams/ferry `.fybl` chip code | THE pattern for overlay text: mirror-aware (`visual x = innerWidth − cameraSpaceX`), `display:none` base CSS (Iron Rule 6) |
| LLM gateway | `lib/agent-core.js`: `GATEWAY_URL` (Vercel AI Gateway `/v1/messages`), `gatewayKey(req)`, `callGateway` (one retry on 5xx/timeout), per-IP rate limiter | reuse all of it; anthropic-version header included |
| Live context line | agent-core system prompt appends `'Now in NYC: ' + weather` | reuse for the bake + Phase 3 prompts |
| POST endpoint shape | `api/agent.js` → `handleAgent`; mirrored in `server.js` | copy this shape for `/api/chatter` (POST, not `makeCachedRoute`) |
| Local script pattern | `scripts/record.mjs` | copy for `scripts/bake-thoughts.mjs` (one-time local bake) |
| Static data assets | `public/personas.json`, `public/pums.json` etc. | the baked sheet ships the same way: `public/thoughts.json`, fetched once at load |
| History gate | global `HIST = {active, day, epochS, liveWx}` | thought layer is hidden whenever `HIST.active` — that is the ONLY history integration |

## Design decisions (settled with the user)

- **Icon-first**: default bubble is a cloud + one icon glyph; text only on hover / close
  zoom. Icons render in the HTML overlay (native emoji), so the mirrored-canvas
  text-flip problem never arises.
- **Thoughts reference live data** — but only via the client-side generator reading the
  live feed caches (weather / subway modules' current state). Baked thoughts are
  **timeless by design** (identity only, no weather/transit) because the sheet is baked
  once and never auto-refreshed.
- **No time-scrubber support**: the entire layer (bubbles + 💭 button) is gated on
  `!HIST.active` in addition to the zoom gate. No recorder changes, no replay plumbing,
  no snapshot fields. One conditional.
- **One-time bake, no automatic updates**: all 12,703 personas in a single local script
  run (~$2–3 once), committed as `public/thoughts.json`. No cron, no Blob, no serving
  route, no running cost. Re-bake manually whenever fresh thoughts are wanted.
- **Anonymity preserved**: no names, no demographic-mapped visuals. Thoughts are
  in-character but unnamed ("Nurse, 43 — Astoria" is as specific as headers get).
- **Polling parked**: `rep` weights make a PUMS-weighted survey engine possible later;
  out of scope now.

## Architecture

### Content sources

**Source 1 — client-side seeded generator (free, instant).** `makeThought(pp)` seeded by
persona index (mulberry32 or similar), two pools:
- *Identity*: keyed off `occIdx` (job), `commuteIdx` (mode), `incomeThousands` (rent/cost
  anxiety bands), `age`, `status` (student/looking/retired), `area` (borough/NTA flavor).
- *Reactive*: reads current client state — the same in-memory feed state the render
  modules hold, no extra fetches. Live data selects WHO reacts, intersected with the
  persona's census attributes, not just what gets thought:
  - weather (precip/wind) → everyone, weighted; temperature extremes age-weighted
    (older residents mind heat/cold more)
  - subway delays → only residents with `commuteIdx` = subway, ideally matched to
    lines serving their home PUMA
  - time of day → occupation/status-matched (workers at 8am, students on weekdays)
  - birds aloft → rare low-probability flavor
  - (optional later: Citi Bike dock state for bike commuters, traffic for drivers)
  Each pool entry carries an icon key.
Weighting: reactive pool gets boosted when something notable is live (precip, major
delays) so the mood visibly sweeps the crowd; otherwise ~60/40 sheet/identity mix once
the sheet loads.
Data-flow directions (explicit): live data → Source 1 thoughts only (baked sheet never
references live conditions); historical/replayed data → thoughts NEVER (layer hidden
under `HIST.active`); thoughts → simulation NEVER (pure presentation — no walker, feed,
or recorded state is altered). Live data reaches the LLM only in Phase 3's prompt
("Now in NYC" line). Note: Source 1 phrasing is canned pools selected by live data;
LLM-written reactions to live events stay Phase 3-only (per-event batched calls would
reintroduce running cost — out of scope).

**Source 2 — one-time baked thought sheet (LLM depth, zero running cost).**
- `scripts/bake-thoughts.mjs`, run **once, locally** (pattern: `scripts/record.mjs`).
  Reads `ai-gateway-key.json` the same way `agent-core.js` does; no serverless function,
  no cron, no time limit.
- Builds persona prose from `public/personas.json` rows (same prose the card shows).
- Batched calls to **Haiku 4.5** (`anthropic/claude-haiku-4.5` via the existing gateway)
  — 16 personas/call, 2–3 thought variants each, strict JSON
  `[{i, thoughts: [{t, icon}]}]` with `icon` from a fixed 12-key enum:
  `rent commute work food family weather money home leisure study health dream`.
  (Baked thoughts must NOT reference live conditions — prompt says timeless.)
- Full 12,703 personas ≈ 800 calls ≈ 10–20 min at concurrency ~8; one-time cost ~$2–3.
  Script is resumable (writes partial output; skips indices already done) so a flaky run
  never wastes spend.
- Output: **`public/thoughts.json`** (compact: array indexed by persona idx, each entry
  `[[t, iconIdx], …]`; ~2–2.5 MB raw, gzips well — smaller than `streets.json`).
  Committed to main **once** alongside the Phase 2 client change (one deploy).
- Client fetches it once at load exactly like `personas.json`.
- Degradation: file missing / fetch fails → Source 1 covers everything.
- Refresh policy: manual only — re-run the script and commit when fresh thoughts are
  wanted. Nothing updates automatically.

**Phase 3 — on-demand live thought.** `POST /api/chatter { idx }` (single persona), shape
copied from `api/agent.js` + `server.js` mirror. Prompt = persona prose + the concierge's
"Now in NYC" live line. Rate-limited per IP (stricter than the concierge; it's one
persona per click). Result shown in the bubble + appended to the `#personaCard` and the
`setFocus` context payload so the Concierge knows what they were thinking. Button hidden
when `HIST.active` or no gateway key (probe like the agent's GET does).

### Rendering (HTML overlay, chip pattern)

- A pool of ≤8 absolutely-positioned bubble divs following the `.fybl` chip pattern
  (Iron Rules 3 + 6: re-mirrored x, `display` toggled from JS).
- Per frame (cheap for 8): `posAt(pp)` → world `(x, z)`; y = `7.4 × clamp(dist/900,1,4)`;
  project → screen; mirror x; position div; hide if off-screen/behind camera.
- Distance fade (opacity ramp) as a cheap occlusion stand-in; real depth-tested bubbles
  (pre-flipped canvas textures on in-scene billboards) are a possible v2, icon-only.
- Bubble anatomy: white rounded cloud, 2px dark border, two trailing dot-circles toward
  the head (classic Sims/comic read), pop-in scale animation, subtle CSS bob.
- Hover (pointer over the div) → expands to icon + text (≤9 words).
- **Plumbob**: small rotating green diamond (CSS 3D or inline SVG) in the same overlay,
  anchored over the focused resident while `#personaCard` is open.

### Selection / scheduling (port of simfrancisco's `_updateBubbles`)

- Gate: camera close enough (tune against the distance-grow regime, e.g. cam-to-ground
  < ~1,500 m) **and** `!HIST.active`.
- Every ~6 s: collect on-screen walkers (project + margin test), shuffle, greedily pick
  ≤8 with min screen separation (~150 px), assign each a thought (Source 2 variant if
  available for that idx, else Source 1; reactive override when notable weather/delays).
- Rotation feels alive; per-resident thought variant index rotates too.

## Files touched

| File | Change |
|---|---|
| `public/index.html` | new §25i `thoughts` module (overlay pool, selection loop, makeThought, sheet fetch, plumbob); 💭 button on `#personaCard`; small CSS block |
| `lib/chatter-core.js` | NEW — persona prose builder + single-persona live thought (Phase 3; shared by script + POST route) |
| `scripts/bake-thoughts.mjs` | NEW — one-time local bake → writes `public/thoughts.json` (resumable) |
| `public/thoughts.json` | NEW — the baked sheet, committed once as a static asset |
| `api/chatter.js` | NEW — Vercel POST route (Phase 3) |
| `server.js` | mirror `/api/chatter` locally (agent.js pattern) |
| `CHANGELOG.md` | user-visible feature → entry at top, same push |

## Phases

1. **Phase 1 — pure client (ship first).** §25i module: Source 1 generator, icon clouds,
   zoom + `!HIST.active` gates, rotation, hover text, plumbob. Zero server changes.
   Verify: bubbles anchor to *moving* walkers at presets, mirror correct (bubble sits
   over the person, not mirrored away), hidden during scrub, `window.__moduleError` clean.
2. **Phase 2 — the one-time bake.** Write `scripts/bake-thoughts.mjs`, dry-run on a
   32-persona slice first (check JSON shape, icon enum adherence, no live-condition
   references, thought quality by eye), then run the full 12,703, commit
   `public/thoughts.json` + client merge in one push. Verify: sheet loads, bubbles mix
   sheet/reactive, missing-file fallback still works (test by renaming the file locally).
3. **Phase 3 — on-demand live thought.** `/api/chatter` + card button + focus-context
   integration. Verify: rate limit, `HIST` hides button, 503 (no key) degrades quietly.

## Costs

| Item | Estimate |
|---|---|
| Phase 1 | $0 |
| One-time bake (all 12,703 personas, Haiku, 2–3 variants) | ~$2–3 **once** |
| Serving thoughts while browsing | $0 (static asset) |
| Recurring / automatic costs | **none** — refresh is manual re-run only |
| Phase 3 click-thought | ~fraction of a cent per click, user-initiated, rate-limited |

## Open decisions

1. Exact zoom threshold + bubble count/cadence — tune by eye at camera presets.
2. v2 in-scene depth-tested bubbles (icon-only, pre-flipped textures) — only if HTML
   overlay occlusion feels wrong in practice.

## Iron-rule compliance

1. Frozen calibration — untouched (screen-space + existing `posAt`). 2. `landOK` — no new
ground placement. 3. Mirror — chip pattern only; any future in-scene text pre-flipped.
4. `pushPoly` — n/a. 5. History — layer hidden when `HIST.active`; no recorder fields.
6. `.fybl`-style chips — set `display` from JS. 7. No cron, no workflows — the bake is a
local script; nothing scheduled anywhere. Changelog — entry ships with Phase 1. Secrets —
bake script + chatter route read the gateway key via the existing `gatewayKey()` /
`ai-gateway-key.json` paths; never log, commit, or echo it.
