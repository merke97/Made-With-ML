# DR Archive · Temporal Explorer

A browser prototype that turns the DR archive into a **temporal map**: a single
continuous, zoomable world where *horizontal movement is time* and *zoom is
detail*. The archive starts as one dense historical ribbon and, as you zoom in,
resolves into Television/Radio, then individual channels, then days, hours, and
finally individual broadcasts.

> The most important idea: the user never feels they *changed view* — they feel
> they *changed scale*. Even though the renderer serves different aggregate data
> at each level, the animation makes it feel like one archive resolving into focus.

This is the **fake-data prototype** described in the project brief (step 14): its
job is to prove the *interaction*, not data accuracy. It runs on ~10 channels of
synthetic broadcasts over 5 years (2019–2023).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
# or
npm run build && npm run preview
```

Requires Node 18+. The timeline renders with WebGL (PixiJS); any modern browser works.

## How to drive it

| Action | Result |
| --- | --- |
| **Drag** | Pan — horizontal is time, vertical scrolls channels |
| **Scroll / wheel** | Zoom in/out, anchored under the cursor |
| **Shift + wheel** | Pan horizontally through time |
| **Click a programme** | Open the detail panel |
| **Search box** | Highlights matching broadcasts on the timeline (clusters glow) |
| **Nyheder toggle** | Overlay TV Avisen / Radioavisen |
| **Dæmp begrænset** | Fade access-restricted broadcasts |
| **Gå til dato** | Jump straight to a date at day-level detail |

## What it demonstrates (MVP checklist)

- ✅ Continuous zoomable time axis, cursor-anchored zoom
- ✅ Coarse **broadcast-density** terrain when zoomed out (broadcast *hours*, not programme count)
- ✅ **Smooth semantic split**: Archive → Television/Radio → channels → programme bars (crossfade, never a hard view switch)
- ✅ **Fixed channel lanes** — rows never reorder while you scroll through time; empty/not-yet-launched channels keep their position
- ✅ Programme bars whose **width = duration**, with labels that fade in only when there's room
- ✅ **Availability state** honestly shown (solid = playable, outline = metadata-only, dim = restricted)
- ✅ Vertical scrolling for the channel list
- ✅ Click → detail panel (accessible DOM, copyable, "Open in DR-arkivet")
- ✅ Overlays that *highlight* rather than replace: news + free-text search

## Architecture

React owns the chrome (toolbar, panels, overlays); **PixiJS** renders the
timeline like a graphics application — no DOM node per programme. The renderer is
immediate-mode and reads a tiny virtual camera every frame.

```
src/
  data/
    types.ts        Channel, ProgrammeInstance, AggregateBucket — the domain model
    channels.ts     The stable track hierarchy (Archive → TV/Radio → channels)
    generate.ts     Synthetic archive: daily rhythms, news slots, reruns, empty days
    aggregate.ts    Precomputed level-of-detail buckets (year/month/day) — the terrain
  timeline/
    camera.ts       Virtual camera: centerTimeMs, msPerPixel, scrollY + cursor-anchored zoom
    zoom.ts         Continuous zoom value + transition bands + easing (the semantic model)
    layout.ts       Track layout engine — fixed lanes that bands split into
    ticks.ts        Adaptive time-ruler granularity (hour → year)
    renderer.ts     PixiJS renderer: ribbons, programme bars, overlays, ruler, hit-testing
    textpool.ts     Reusable Text pool (no per-frame allocation)
    store.ts        Minimal observable store shared by React + renderer
  ui/               React shell: TimelineView, Toolbar, DetailPanel, Overlays
```

### The semantic-zoom model (`timeline/zoom.ts`)

A single continuous `zoom = log2(BASE / msPerPixel)` drives everything. Transition
*bands* define where each layer fades in:

```
archive ──[1.0–2.4]──▶ TV/Radio ──[3.2–5.2]──▶ channels ──[6.6–8.6]──▶ programmes
                                                  labels [8.8–9.8]
```

For each transition, `progress = smoothstep(start, end, zoom)` drives both opacity
(parent fades out, child fades in) and position (children interpolate from their
parent band's centre to their own fixed lane). Because the time under the cursor
stays pinned and the lanes line up spatially, it reads as one object resolving —
not a sequence of separate charts.

### Why broadcast hours, not programme count

The zoomed-out terrain encodes *amount of broadcast time* per bucket, normalised
per track. Programme count is misleading (a day of short clips would outshine a
day of long broadcasts); broadcast hours answer the real question — *how much
archive material exists here?*

## Real data — DR-arkivet (live mode)

The app can run on the **actual** DR archive (the Royal Danish Library's Solr
index behind kb.dk), not just synthetic data. Use the **Syntetisk / DR-arkivet**
switch in the toolbar; pick a date window and hit **Hent**.

Because the browser can't call kb.dk directly (no CORS + a `SameSite=Strict`
auth cookie), a small **server-side proxy** is required. It's included:

```
server/
  kb.mjs        # holds the anonymous auth cookie, forwards Solr calls (re-auths on 401)
  solr.mjs      # pure query builders + response→domain mappers (offline-testable)
  handlers.mjs  # /api surface (§11): channels, total, histogram, window, search — cached
  index.mjs     # standalone server  (npm run server)  — adds CORS for separate hosting
  mock-kb.mjs   # a local fake kb.dk for offline verification (npm run mock-kb)
```

In `npm run dev` the proxy is mounted as Vite middleware at `/api/*`, so the
front-end gets real data with **no extra process and no CORS**:

```bash
npm run dev            # app + proxy at http://localhost:5173, talking to kb.dk
```

Live mode loads a **bounded window** (the chosen date range) into the same
in-memory shape the synthetic path uses — real channels (`creator_affiliation`),
programme spans (`startTime`/`duration_ms`), genres, availability from
`has_kaltura_id`, and a deep link into DR-arkivet on each detail panel. The data
contract is documented in [`docs/SOLRAPISPEC.md`](docs/SOLRAPISPEC.md); the
mapping lives in `server/solr.mjs`.

**Hosting note:** GitHub Pages is static, so the public demo stays synthetic.
To make a deployed site live, host the proxy (`npm run server`, or any Node host)
and point the front-end at it with `VITE_API_BASE=https://your-proxy` at build time.

**Verify offline** (no kb.dk access needed):

```bash
npm run mock-kb &                       # fake kb.dk on :8787
KB_BASE=http://localhost:8787 npm run dev   # proxy talks to the mock
```

The "stream a tile per viewport" model from the brief is the natural next step
on top of this bounded loader — `data/live.ts` already speaks the histogram +
window endpoints a tile server would expose.

## Relationship to the real archive

The aggregate levels in `data/aggregate.ts` mirror what a production
**temporal tile server** would precompute: the frontend requests only the
current viewport and the backend returns aggregate density when zoomed out or
individual programme spans when zoomed in — "send tiles, not the whole world",
like a map engine.

## Deliberately out of scope (next steps)

Thumbnails, historical-event curation, 3D, rerun-collapsing, transcripts, full
channel hierarchy, and timezone/broadcast-day handling are intentionally deferred.
The first goal is only: *does moving through DR archive time feel good?*
