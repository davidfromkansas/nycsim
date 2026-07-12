# Task: GBA mobile shell — Game Boy Advance emulator layout for portrait phones

Audience: a coding agent joining this repo. Read `AGENTS.md` first — the Iron Rules
(frozen calibration, `landOK`, THE MIRROR, parallel-work discipline) all apply.
Anchors below were verified against the working tree on 2026-07-12; line numbers drift —
re-verify with grep before editing. A parallel agent has uncommitted work in
`public/index.html` (Brooklyn massing); coordinate scope, keep the diff surgical, and
`git pull --rebase` before every push.

---

## For the non-technical reader: what is this and how will it work?

The city is genuinely hard to drive on a phone today: the ride-along icons stack down
the right edge over the scene, the joystick floats mid-screen, and everything competes
with the 3D view for the same small glass.

**The fix: on portrait phones, the whole site becomes a Game Boy Advance.** The top
two-thirds of the screen is the "game screen" — the live NYC simulation, full width,
with the ride-along icons (✈️ 🚇 ⛴️ 🚌 🚲 📷 🐦) lined up horizontally along the
screen's bottom edge like a game's item bar. The bottom third is the console shell:
the NYC-SIMULATOR logo printed at its top (like the branding under a real GBA screen),
a D-pad on the left that flies the camera, and A/B buttons on the right that do real
things (A opens the City Concierge, B backs out of whatever you're looking at).
Turn the phone sideways or open it on a desktop and nothing changes — this design
exists only where it helps: portrait phones.

## Goal (technical)

On `(max-width: 700px) and (orientation: portrait)` touch devices:

1. The WebGL canvas renders in the **top ⅔ of the viewport only** (full width) — a real
   perf win (~33% fewer pixels) and an authentic emulator frame.
2. The bottom ⅓ is a new GBA-style shell panel: logo top-center, functional D-pad
   (left) + A/B (right) + Start/Select (center-bottom).
3. The 7 entity ride-along buttons (`#ui #presets`) move from the right-edge vertical
   column to a **horizontal row pinned to the bottom edge of the screen area**.
4. Everything else (HUD chip, timeline scrub, tickers, concierge FAB, credit) stays as
   overlays **inside the screen area**, repositioned to fit.
5. Desktop, landscape phones, and tablets are pixel-identical to today.

## Design decisions (settled with the user, 2026-07-12)

- **Controls are functional, not chrome.** D-pad replaces the floating joystick for fly
  movement. A/B/Start/Select map to real actions (proposed mapping in §GBA-3; exact
  assignments are adjustable — confirm with the user before shipping).
- **Remaining UI overlays the game screen** (in-game-HUD style); it does NOT move into
  the shell panel. The shell holds only: logo, D-pad, A/B, Start/Select.
- **Portrait phones only** (`max-width:700px` + `orientation:portrait`). Landscape
  phones and tablets keep the current layout. Rotation toggles live.
- **Renderer truly confined to the top ⅔** — not a full-screen canvas with an opaque
  panel on top.

## What already exists (do not rebuild)

| Anchor (grep, don't trust line #s) | What it is |
|---|---|
| `@media (max-width: 700px)` block near `#ticker { bottom:env(` (~line 177) | Current phone layout: `#ui` becomes the right-edge vertical icon column (`bottom:calc(198px + safe-area)`), `#photo` + `.sep` hidden, 48px icon buttons |
| `#joy` / `#joyK` (~53, 520) + `body.touchnav #joy` | Floating virtual joystick, bottom-center. Its pointer handlers live in §26c — **reuse its state-writing, don't fork the movement math** |
| §26c `MIRROR MATH` comment (~5059) | Fly navigation: desktop WASD + mouse-look, mobile joystick + drag-to-look. Touch devices live permanently in fly mode |
| `renderer.setSize(innerWidth, innerHeight)` (~1682), `camera.aspect` (~1692), resize handler (~5226), `uni.uAspect` (~5379) | The only renderer-sizing sites |
| `canvas.mirrorX { transform: scaleX(-1) }` (~494) + pointer shim (~1706–1718) | THE MIRROR. The shim re-mirrors via `r.left + r.right - e.clientX` (getBoundingClientRect) — **rect-based, so it survives a resized canvas untouched** |
| `(0.5 - _v.x*0.5)*innerWidth, (-_v.y*0.5+0.5)*innerHeight` (≈16 sites: flights, ferries, subway, buses, birds, cams, kiosks, personas, labels…) | NDC→screen chip/label projection. `innerWidth` stays valid (canvas is full-width at origin); **every `innerHeight` here must become the render height** |
| `#agentFab` (~596, CSS ~299), `#hud` (~524, scale .72 ≤820px), `#credit` (~79), `#ticker`/`#thoughtTicker` (~160–214), `#camview` (~94, `top:50%`) | Overlays to reposition under the new mode |
| `#brand` / `nycsim-logo.png` (~537, hidden ≤820px) | The logo asset the shell reuses |
| tour pull-back `mz = matchMedia('(max-width: 700px)')… 1.587` (~4938) | Tour framing already special-cases phones; re-verify framing on the new ⅔ aspect |
| `#dbg` hash, `window.__moduleError`, `__cam`, presets keys 0–6 | Testing hooks (AGENTS.md) |

## Architecture

### GBA-1. Mode gating — one body class, one render-height variable

- `const GBA_MQ = matchMedia('(max-width: 700px) and (orientation: portrait)')`;
  set `body.gba` when it matches AND the device is touch (same touch check `touchnav`
  uses). Listen for `change` → toggle class → run the existing resize path.
- Introduce module-scope `let RH = innerHeight` ("render height"). In the resize
  handler (and at init): `RH = document.body.classList.contains('gba') ?
  Math.round(innerHeight * 2/3) : innerHeight`. Then `renderer.setSize(innerWidth, RH)`,
  `camera.aspect = innerWidth / RH`, `uni.uAspect.value = innerWidth / RH`.
- **Sweep every projection site**: replace `innerHeight` with `RH` in the ~16
  NDC→screen helpers and the screen-center math (`cx/cy` near the persona follow code,
  ~8806) and the label cull bounds (~8732). Grep `innerHeight` and audit every hit;
  leave non-projection uses alone (e.g. the visualViewport keyboard offset for the
  agent chat, ~9956). On desktop `RH === innerHeight`, so this sweep is **zero-risk
  to desktop by construction**.
- Canvas must stay anchored top-left (it already is; `setSize` writes inline
  width/height style). The page below it shows the shell panel.

### GBA-2. The shell panel (bottom ⅓)

New fixed-position `#gba` div, `display:none` outside `body.gba`:

- `position:fixed; left:0; right:0; bottom:0; height:calc(100% / 3);` absorbing
  `env(safe-area-inset-bottom)` as internal padding. `z-index` above tickers.
- **Look**: GBA-style shell — indigo/violet body (`#5661a8`-family gradient), subtle
  top bevel where it meets the screen, rounded shoulder corners, screen bezel lip
  (dark strip with the classic angled corner) at the panel's top edge. Pure CSS —
  no images beyond the existing logo. Match repo style: dense, no frameworks.
- **Logo**: `<img src="nycsim-logo.png">` top-center of the panel (`#gbaBrand`,
  ~40% width, drop-shadow) — the "GAME BOY ADVANCE" print position.
- **D-pad** `#gbaDpad` left side: one element, 4 hit zones (8-way via diagonal
  overlap), classic cross styling with pressed states.
- **A/B** `#gbaAB` right side: two round buttons, offset diagonally like the real
  hardware, labeled A and B.
- **Start/Select** center-bottom: small pill buttons.
- All controls `touch-action:none`, `user-select:none`, ≥44px hit targets,
  `navigator.vibrate?.(8)` on press (no-op where unsupported).

### GBA-3. Wiring the controls (reuse §26c, don't fork it)

- **D-pad → fly movement.** Grep the `#joy` pointer handlers in §26c and find the
  state they write (the joystick vector the fly loop consumes). The D-pad pointer
  handlers write the SAME state with unit-digital values (e.g. up = forward vector
  `(0,-1)`, corners normalized diagonals). Movement math, speed, mirror-corrected
  strafing all stay in one place. Under `body.gba`, hide `#joy` (the D-pad replaces
  it); everywhere else `#joy` behaves exactly as today.
- **Drag-to-look stays**: touching the screen area itself keeps today's drag-look
  (§26c synthetic-event path) — D-pad moves, thumb-on-screen looks. Two-handed GBA.
- **Proposed button mapping** (confirm with user; keep each a ≤3-line handler that
  calls existing functions — no new behavior code):
  - **A** — open the City Concierge (delegate to the `#agentFab` click path).
  - **B** — "back out": close whichever is open, in priority order — cam viewer →
    persona card → focus/follow mode → agent panel; if nothing is open, snap the
    timeline to `now` (the `#timeReset` path).
  - **Start** — restart the Manhattan auto-tour (the desktop `#photo` button's
    handler; that button is hidden on phones today, so Start resurrects it).
  - **Select** — toggle the two ticker strips (news + thoughts) on/off.

### GBA-4. Relocating the entity icons + overlay repositioning (CSS only)

All inside a new `body.gba` CSS block; **no JS changes** for these — same elements,
same handlers:

- `#ui`: horizontal row, full width, pinned to the bottom edge of the screen area
  (`bottom:calc(100%/3)`), buttons ~44px, evenly spaced, slight translucent backing
  so they read against the scene — the "item bar" on the screen's bottom edge.
- `#ticker` + `#thoughtTicker`: stacked directly ABOVE the icon row (still inside
  the screen). Their existing ≤700px `bottom:` offsets get `body.gba` overrides.
- `#agentFab`: bottom-right of the SCREEN area, above the icon row.
- `#hud` (chip + scrub + alerts): stays top-left, keeps the .72 scale.
- `#credit`: stays top-right of the screen area.
- `#camview`: `top` centers on the screen area (`top:calc(100%/3)` → i.e. 50% of ⅔),
  not the viewport. Same for anything else centered at `top:50%` — grep and audit.
- Agent chat panel: verify it opens within the screen area and the keyboard-offset
  code (visualViewport, ~9956) still clears the panel; adjust its `bottom` under
  `body.gba` if it collides with the shell.

## Files touched

- `public/index.html` — everything: `body.gba` CSS block, `#gba` panel markup, one new
  §-numbered JS module (suggest **§26e "GBA mobile shell"** — mode gating + D-pad/button
  wiring), the `RH` plumbing in §4/§26c/resize, and the `innerHeight→RH` projection
  sweep. Keep it one contiguous CSS block + one contiguous JS section where possible;
  do not renumber existing sections.
- `CHANGELOG.md` — user-visible feature → entry at the TOP, same push (title, Shipped
  date, TL;DR, What you'll see, How it works — no external data sources here, so that
  clause is just the mechanism).
- Nothing in `lib/`, `api/`, `vercel.json` — this is 100% client presentation.

## Phases (each independently shippable)

1. **Layout + shell, decorative** — `body.gba` gating, `RH` plumbing + projection
   sweep, canvas at ⅔, shell panel with logo (controls drawn but inert), icon row
   relocated, overlays repositioned. This is the risky half; verify hard (below).
2. **Functional controls** — D-pad wired to the joystick state, A/B/Start/Select
   handlers, `#joy` hidden under gba, haptics.
3. **Polish + ship** — pressed states, bezel details, safe-area edge cases
   (notch/home-indicator), rotation-toggle stress test, CHANGELOG entry.

## Verification (before every push — every push deploys)

- `window.__moduleError` FIRST after any change (AGENTS.md).
- Browser-pane mobile preset (375×812 portrait): screen occupies exactly top ⅔; icons
  in a row at its bottom edge; logo + D-pad + A/B in the shell; nothing renders
  behind the shell.
- **Picking + chips on the resized canvas**: tap a ferry/bus/cam chip and a resident —
  cards open on the correct entity (this validates the mirror shim + `RH` sweep).
  Chip labels track their entities near the BOTTOM of the screen area (the region the
  old `innerHeight` math would get wrong).
- D-pad: 8 directions fly correctly under the mirror (screen-right = screen-right);
  drag-look on the screen still works simultaneously.
- A/B/Start/Select each do their mapped action; B's priority order closes the right
  thing when several are open.
- Rotate to landscape → today's layout returns, canvas full-height, no dead pixels;
  rotate back → shell returns. Repeat several times (resize-handler idempotency).
- Timeline scrub + history replay still render chips correctly in gba mode (`HIST`
  untouched, but chips replay through the same projection).
- Desktop (≥701px): pixel-identical spot-check at presets 0–6 (`RH === innerHeight`
  everywhere) + screenshots before pushing.
- Tour framing on the ⅔ portrait aspect (the ~4938 `mz` pull-back) — Manhattan should
  still fit the frame; retune the phone factor only if it visibly clips.

## Iron-rule compliance

1. **Frozen calibration** — untouched; zero geo math in this feature.
2. **`landOK`** — n/a, nothing placed in the scene.
3. **THE MIRROR** — the `scaleX(-1)` canvas + rect-based pointer shim are untouched
   and survive the resize by construction; the projection sweep changes only the
   height term. Any new shell control lives OUTSIDE the canvas, so it never crosses
   the mirror at all.
4. **No `pushPoly`** — n/a, pure DOM/CSS.
5. **History gating** — no new live layer; `HIST` contract untouched.
6. **`.fybl`** — untouched.
7. **No `.github/workflows/`** — nothing scheduled.

## Open decisions (confirm with the user during Phase 2)

- Final A/B/Start/Select mapping (proposal in GBA-3).
- Whether the shell shows a decorative speaker grille / LED, and whether the LED can
  double as the LIVE/history indicator (fun, cheap, but optional).
- Whether tablets in portrait (701–820px) eventually want the shell too — explicitly
  out of scope for v1.

## Explicitly out of scope

- Landscape-phone shell variant, tablet support.
- Any change to desktop layout, fly physics, or the §26c movement math.
- Sound effects, button remapping UI, gamepad API.
