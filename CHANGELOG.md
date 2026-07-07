# Changelog

User-visible features, newest first. Format per entry: **Title · date shipped · TL;DR ·
What you'll see · How it works** (with source links). See AGENTS.md → "Changelog" for
the rules on adding entries.

---

## 🎯 Focus Mode + agent click-context

**Shipped:** July 7, 2026

**TL;DR:** Click any dialogue in the scene and two things happen: every other dialogue
steps back so you can concentrate on the one you chose, and the City Concierge learns
what you're following so questions like "what am I looking at?" answer themselves.

**What you'll see:**
- Clicking any entity chip — a bus, subway train, ferry, aircraft, bird flock, Citi Bike
  station, traffic reading, or a concierge map pin — hides all other chips, labels, and
  UI chrome. One pinned dialogue remains, tracking its entity as it moves; only the
  weather chip and the concierge stay alongside it.
- Release by clicking anywhere on the scene, scrolling, pressing **Esc**, or clicking
  the pinned chip (it says so on the chip). Everything returns instantly.
- Citi Bike stations and traffic readings are newly clickable (stations get a gentle
  camera dive; readings pin in place). The traffic-camera video viewer keeps its own
  window and is not part of focus mode.
- Ask the concierge "what am I following?" after any click and it answers with the
  exact entity and its live numbers — for up to 15 minutes after the click, even after
  you've released the visual focus.

**How it works:** every dialogue click records a focus snapshot (kind, label, and the
entity's current data — e.g. a flock's radar estimate or a bus's route/street/speed).
The snapshot rides along invisibly with each concierge request, where the server
sanitizes it and appends a "user is following: …" line to the model's context. The
visual side is a single tracked overlay chip plus a body-level CSS state that hides
everything else; releasing the focus never discards the agent context.

---

## 🐦 Live bird migration (BirdCast radar), citywide

**Shipped:** July 7, 2026

**TL;DR:** Real-time bird migration rendered as 3D flocks over all four built
boroughs — Manhattan, Brooklyn, Queens, and the South Bronx — each flying the
direction, speed, and altitude that weather radar is measuring for that county
right now.

**What you'll see:**
- Flock size tracks the radar count: a quiet July afternoon renders a handful of
  birds; a 25,000-bird migration night hits the 600-bird cap. Each borough's birds
  fly *that county's* measured heading and speed in its measured altitude band
  (typically 400–700 m — above everything but the supertalls). ~40% travel in
  V-formations that bank together; the rest fly solo; wings alternate between
  flapping and gliding.
- Flock chips state exactly what a flock is: *"Migration radar · Queens — ≈96 birds
  aloft (radar est.) · ~431 m · S 15 mph"*, plus *"daytime — low confidence"*
  whenever BirdCast's own quality flag says the reading is noise-tier. A flock is a
  visualization of one radar measurement — not tracked individuals, and not a count
  of the borough's birds (perched and low-flying birds are invisible to radar).
- Click a flock chip to glide in and ride along with the stream. The **Birds**
  preset button (key **7**) flies you to wherever the flock currently is.
- At 500+ birds aloft the weather chip shows the citywide count; past 2,000
  crossings it adds the running nightly total and, once a week of history has
  accumulated, a percentile rank (*"48,200 crossed tonight (94th pctile)"*).
- Nightly 1 am snapshots record it all, so the time slider replays past migration
  nights. The City Concierge reads the same feed — including per-borough numbers,
  the confidence flag, and season context (why a July sky is quiet) that stays out
  of the UI on purpose.

**How it works:** the Cornell Lab of Ornithology's [BirdCast](https://birdcast.org)
project (with Colorado State University and UMass Amherst) measures nocturnal bird
migration using the national NEXRAD weather-radar network and publishes county-level
estimates every 10 minutes — the same numbers behind their public
[Migration Dashboard](https://dashboard.birdcast.org/region/US-NY-061). The backend
reads the four NYC county rows (New York, Kings, Queens, Bronx) from that dataset
and serves them through a cached `/api/birds` endpoint with an aloft-weighted
citywide rollup. The renderer scales the visible flock with √(true count) — one
draw call for all 600 birds — and deals skeins to boroughs by each county's share.
Nightly totals land in the daily snapshot archive, which is what powers both replay
and the percentile ranking.

*Data credit: BirdCast — Cornell Lab of Ornithology / Colorado State University /
UMass Amherst.*
