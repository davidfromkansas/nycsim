# Task: `Home` — sign in, set your address, and the city opens at YOUR block

Audience: a coding agent joining this repo. Read `AGENTS.md` first — the Iron Rules and
the parallel-work discipline all apply. Anchors below were verified against the working
tree on 2026-07-14 (commit 78ec318); line numbers drift — re-verify with grep before
editing. This is a PHASED feature: ship Phase 1 alone; Phases 2–3 are sketched so
Phase 1's data model doesn't paint us into a corner.

---

## For the non-technical reader: what is this and how will it work?

**The problem.** NYC Sim is a spectacle you visit; nothing in it is *yours*. The user
research signal (conversations + logs) says people's first instinct is to look up their
own home. Today that's a manual fly-around, and next visit you start from scratch.

**The fix.** A **Home button**. Click it signed out → Google sign-in → type your
address once → the camera flies to your block and a small beacon marks your home. Every
return visit opens *at your home* — and a home panel answers the questions a resident
actually has: when's the next train at my station, how many Citi Bikes are on my
corner, is a ferry coming, what's the weather doing. All of that data is already live
in the app; Home just anchors it to your address.

**Privacy stance (the honest version).** We never store your street address — it's
converted to map coordinates once and discarded. Coordinates are encrypted at rest in a
private store. Nothing about you is visible to anyone else in Phase 1; if the social
phase ships later, it's opt-in and only ever shows your *neighborhood* ("Astoria"),
never your address or exact location.

**What it costs.** One Google geocode per address change (inside the existing $10/month
Places ceiling — see plan-find-place.md); storage is the already-provisioned Vercel
Blob store. No new paid infrastructure.

---

## Phases (Phase 1 = this plan's build scope)

| Phase | Scope | Ships when |
|---|---|---|
| **1 — My Home** | Google SSO · address → home · Home button + boot-to-home · home beacon · home panel (nearby live info) · sign out / delete account | this plan |
| 2 — Preferences | pinned feeds, default camera/mode, concierge knows "my home" ("when's MY next train?") | after 1 proves out |
| 3 — Social | opt-in public presence (neighborhood-level ONLY), friends, design-your-own-home | needs its own plan |

Phase-proofing baked into Phase 1: the profile JSON has room for `prefs{}` and
`pub:false` from day one, and the concierge focus-context hook (`setFocus`) already
exists — Phase 2 is mostly wiring, not migration.

## Where this lives

| Anchor (grep for it) | What's there today | What you add |
|---|---|---|
| `lib/agent-log.js` | zero-dep raw Blob REST (put/list via fetch, `BLOB_READ_WRITE_TOKEN`) | copy the pattern into `lib/home-core.js` for profile read/write |
| `function placesKey` + `findPlace` (`lib/agent-core.js` ~643) | Places Text Search w/ NYC restriction, 24 h cache, daily budget, 429 circuit breaker | export a `geocodeAddress(q)` that reuses the SAME key/budget/breaker (do NOT build a second Google client) |
| `whereIs` internals (`lib/agent-core.js`) | point-in-polygon over `boundaries.json` → borough + NTA | call it to derive the public-safe neighborhood label |
| `api/agent.js` + 2-line mirror in `server.js` | the real-file-beats-rewrite POST pattern | `api/home.js` → `handleHome`, same mirror |
| `#gbaReset` (`public/index.html` ~737, §26e) | mobile RESET: reload → boot → auto-tour | RESET is RETIRED — the button is HOME for everyone: signed-out tap opens sign-in, signed-in tap flies home. Only when Home is unconfigured (no `GOOGLE_CLIENT_ID`) does it fall back to the old RESET behavior |
| `#gbaFeedback` / desktop Feedback pill (commit 699e5ea) | the two-surface button pattern (desktop pill + GBA button) | Home button follows it exactly |
| `PRESETS` / `flyTo` (~5457) | named camera flights | `flyTo` to home coords; boot-to-home replaces auto-tour destination when signed in |
| `subway` stations + per-stop arr/dep, `citibike` §25e, `ferries`, `buses` §25d | live feeds with per-entity coords | home panel = nearest-X queries over data ALREADY in the client; zero new polling |
| `setFocus` / `focusui` | focus-context + chip pinning | home beacon click → focus, concierge context for free |

## Step 1 — auth (Google SSO, zero-dep)

- **Client**: Google Identity Services script (`https://accounts.google.com/gsi/client`)
  — a CDN include like Three.js, allowed. `google.accounts.id.initialize({ client_id,
  callback })` + `renderButton` inside a small sign-in modal opened by the Home button.
  No One Tap auto-prompt (uninvited popups are off-brand for this app).
- **Server** (`lib/home-core.js`): client POSTs the GIS `credential` (a Google-signed
  ID-token JWT) to `/api/home/login`. Verify it with Google's tokeninfo endpoint
  (`https://oauth2.googleapis.com/tokeninfo?id_token=…`) — zero crypto code, Google does
  the signature check; we assert `aud === GOOGLE_CLIENT_ID`, `iss` is google, `exp`
  fresh. (Login-only latency; fine. Swap to local JWKS verification later if login
  volume ever matters.)
- **Session**: issue our own cookie — `base64url({sub, exp:+30d}) + '.' +
  HMAC-SHA256(payload, SESSION_SECRET)` via `node:crypto`. `HttpOnly; Secure;
  SameSite=Lax; Path=/api/home`. Every `/api/home/*` request re-verifies the HMAC.
  No server-side session store needed.
- **CSRF**: SameSite=Lax + JSON-only bodies + reject requests without
  `Content-Type: application/json`. Sufficient for this shape.
- **Rate limits**: reuse the per-IP pattern from `handleAgent` (8/min login+set).
- **New config**: `GOOGLE_CLIENT_ID` (public, appears in client — fine),
  `SESSION_SECRET` (32+ random bytes; `vercel env add` + git-ignored
  `session-secret.json` locally, same loading pattern as `placesKey`). Console step for
  the USER: create the OAuth client, authorized JS origins = prod URL +
  `http://localhost:4173`.

## Step 2 — address → home (`POST /api/home/set`)

1. Body `{address}` (session required). Geocode via the **existing** `findPlace`
   machinery (same key, NYC `locationRestriction`, same daily budget + circuit
   breaker — export a thin `geocodeAddress` from agent-core rather than duplicating).
2. Top candidate → validate inside `NYC` bbox → `whereIs(lat,lon)` → borough + NTA.
3. Return `{formattedAddress, lat, lon, borough, neighborhood}` to the client for a
   **confirm step** ("Is this your building?" — camera pre-flies there). Nothing is
   saved yet.
4. `POST /api/home/confirm {lat,lon,borough,nta}` → save. **The address string is
   never persisted** — we can't leak what we don't keep.

**Profile blob** — `homes/<sha256(sub)>.json` in the existing private Blob store:

```js
{ v: 1, sub_h: <sha256(sub)>,          // never the raw Google sub
  name: <given name only>,              // for "Welcome back, David"
  email: <plaintext>,                   // USER DECISION 2026-07-14: kept readable so the
                                        // owner can email users for feedback; private
                                        // store only, never in any API response or log
  enc: <AES-256-GCM({lat,lon}, key=HKDF(SESSION_SECRET,'home-loc'))>,  // iv+tag+ct, node:crypto
  boro, nta,                            // public-safe derivations, plaintext (Phase 3 needs them listable)
  prefs: {}, pub: false,                // Phase 2/3 placeholders
  ts }
```

Endpoints: `login`, `logout`, `me` (GET → `{name, home:{lat,lon,boro,nta} | null}`,
decrypted server-side for the owner only), `set`, `confirm`, `delete` (blob delete +
cookie clear — account deletion is table stakes). All under `handleHome` in
`lib/home-core.js`; `api/home.js` + `server.js` mirror route them.

## Step 3 — client (index.html, §26f — new section, keep numbering discipline)

- **Home button, two surfaces** (copy the Feedback pattern from 699e5ea): desktop pill
  under the logo; on phones the GBA **RESET button becomes HOME outright** (label/aria
  swap, reset behavior retired — a browser reload covers it). Signed-out tap → sign-in
  modal; signed-in tap → fly home. If Home is unconfigured (no client id from the
  server), the button silently stays RESET.
- **Boot-to-home**: on load, `GET /api/home/me` (cookie rides along). If a home exists
  → after boot, `flyTo` home (altitude ~300 m, `highlight_radius_m`-style ring ~150 m)
  INSTEAD of the §26e auto-tour. Signed-out flow byte-identical to today.
- **Home beacon**: one small marker at `subway.geoRaw(lat,lon)` (Iron Rule 1 — never
  `geoToWorld`). A ~10 m voxel house or soft light column, y-raised to sit above the
  DCP massing rather than inside it. `landOK` is guaranteed by geocode+bbox but assert
  anyway (Iron Rule 2). Click → `setFocus('home', …)` + camTween, following the chip
  patterns (mirror math per Iron Rule 3; if it's a DOM chip, `.fybl` needs
  `style.display='block'` — Iron Rule 6).
- **Home panel** (opens on arrival + from the beacon): computed entirely client-side
  from feeds already polling — zero new endpoints, zero new upstream load:
  - **Subway**: nearest 1–2 stations ≤ 700 m (stations list already loaded); next
    arrivals from active trips' per-stop arr times (the data the corridor easing
    already consumes). `"1 · South Ferry — 3 min, 11 min"`.
  - **Citi Bike**: nearest dock ≤ 400 m — live bikes/docks counts (§25e `st` records).
  - **Ferry**: if a dock is ≤ 1 km, vessels whose `next` is that dock + `nextEtaMin`.
  - **Buses**: routes observed on edges ≤ 300 m in the last poll (join via
    `edgeId/street` keys — this is exactly what AGENTS.md's join-key rule is for).
  - Weather chip already global; don't duplicate it.
- **HIST gating** (Iron Rule 5): the panel reads live module state, so in replay it
  shows the replayed values automatically — but hide the "min away" phrasing when
  `HIST.active` (arrival ETAs against a past epoch are nonsense; show "as of <day>").
  The beacon itself is not a live layer → no recorder changes.

## Iron-rule checklist for this feature

1 ✅ `subway.geoRaw` only · 2 ✅ landOK assert on beacon · 3 ✅ chip/picking follows
existing mirror patterns · 4 n/a (no ground polys) · 5 ✅ panel copy switches in
replay; no recorder fields needed · 6 ✅ `.fybl` display · 7 ✅ no workflows — cron
untouched.

## Security / privacy non-negotiables

- Address string: geocoded, confirmed, **discarded**. Coordinates AES-GCM-encrypted at
  rest; only decrypted for the authenticated owner. Public surface in Phase 1: nothing.
- Email is stored **plaintext** in the private blob (user decision: feedback outreach).
  It must never appear in an API response, log line, or agent-log blob — it exists for
  the owner reading the store directly, nothing else. Non-technical framing for the
  changelog: "your Google email is kept privately so we can reach out about feedback."
- `SESSION_SECRET`, tokens, blob contents: never logged, committed, or echoed
  (AGENTS.md secrets rule). `session-secret.json` → `.gitignore`.
- No public listing endpoint of any kind in Phase 1 (Phase 3 designs that separately,
  opt-in, NTA-only).
- Missing config degrades gracefully: no `GOOGLE_CLIENT_ID` → Home button hidden; no
  Blob token → login replies 503 "home is napping"; nothing crashes (house standard).

## Explicit non-goals (Phase 1)

- No friends, no presence, no public anything. No home customization.
- No preferences UI (the `prefs{}` field exists, nothing writes it).
- No analytics on homes; email is stored but nothing automated ever sends to it.
- No npm deps, no framework, no client build step — same as ever.

## Testing (before any push — every push deploys)

1. `node -e "require('./lib/home-core.js')"` + `require('./lib/api-core.js')` syntax gates.
2. Local end-to-end: `node server.js` → sign in (localhost origin on the OAuth client)
   → set a known address (e.g. a Chelsea one) → confirm camera lands on the right
   block → reload → boots straight home. `window.__moduleError` FIRST, then smoke
   counts (`__personas.list.length`, `__traffic.total` — AGENTS.md).
3. Cookie tampering: flip a byte in the session cookie → 401, clean signed-out UI.
4. Degradation: remove `google-maps-key.json` → address set fails politely, login
   still works; remove Blob token → 503 path; signed-out user sees today's app
   byte-identical (screenshot-diff the boot flow).
5. Replay: scrub the timeline → panel switches to "as of <day>" copy.
6. Mobile GBA: HOME button flies home when signed in, opens sign-in when signed out;
   buzz feedback intact; with Home unconfigured the button behaves as RESET.
7. Prod after env vars land: full loop on the Vercel URL + a second device to prove
   the cookie/session survives.

## Changelog

User-visible → top of `CHANGELOG.md`, house format. Be honest in **How it works**:
Google Sign-In for identity, Google geocoding at address-set time (credit both), the
address is discarded after geocoding, coordinates encrypted at rest, arrival times are
the same live MTA/NYC feeds the map already shows — a convenience view, not a new data
source.

## Acceptance criteria

- Signed-out: app is byte-identical to today EXCEPT the RESET button is now HOME and
  opens the sign-in modal (RESET behavior retired by user decision; unconfigured
  deployments keep RESET).
- Sign in → set address → confirm → beacon + panel appear; reload opens at home within
  one boot; next-train/bike counts match what the map itself shows at that corner.
- Raw address appears nowhere at rest (blob inspected); coords unreadable without the
  server key; delete-account removes the blob and signs out.
- Diff surface: `lib/home-core.js` (new), `api/home.js` (new), tiny exports in
  `lib/agent-core.js`, `server.js` mirror lines, `public/index.html` §26f + button
  wiring, `.gitignore`, `CHANGELOG.md`. Nothing else — parallel-agent discipline.
