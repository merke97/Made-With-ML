# Tidsrummet · DR Arkiv

A browser prototype that turns the DR archive into a **temporal map**: a single
continuous, zoomable world where *horizontal movement is time* and *zoom is
detail*. The archive starts as one dense historical ribbon and, as you zoom in,
resolves into Television/Radio, then individual channels, then days, hours, and
finally individual broadcasts.

> The most important idea: the user never feels they *changed view* — they feel
> they *changed scale*. Even though the renderer serves different aggregate data
> at each level, the animation makes it feel like one archive resolving into focus.

**Design ("Tidsrummet"):** the archive is one pigmented object floating on warm
daylight paper — no boxes, no panels, no legend, and (almost) no written labels.
Identity is carried by the material itself: television is cool blue, hard
bucket-cut *blocks* (the picture tube); radio is warm amber, a smooth continuous
*ribbon* (the dial lamp). Density is pigment depth; availability is the
material's state (full pigment / hollow outline / washed out); search and lenses
work by *recession* — everything outside them loses its pigment. The only red on
screen belongs to the selection. All controls live in one summonable command
line. Six encodings — medium, amount, state, focus, selection, place — and
anything on screen that can't point at one of them gets deleted.

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
| **Double-click / double-tap** | Fly one semantic level deeper (⇧ + double-click: back out) |
| **Shift + wheel** | Pan horizontally through time |
| **Click a programme** | It lifts from the paper; its metadata is set beside it |
| **`/` or just type** | The command line rises: search words recede everything else |
| **Type a date** (`15. juni 2021`, `juni 2021`, `2021`) | Enter flies there |
| **Type `nyheder` / `kun tilgængelige`** | Toggles a lens; the rest of the archive pales |
| **Enter on a search** | Flies to (and selects) the nearest match |
| **Esc** | Unwinds: closes the line, clears the lens, drops the selection |

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

React owns the little chrome that remains (command line, meta float, whispers);
**PixiJS** renders the timeline like a graphics application — no DOM node per
programme. The canvas is transparent (the page paints the daylight gradient) and
a CSS mask fades the world out at the screen edges. The renderer is
immediate-mode and reads a tiny virtual camera every frame. The same per-channel
strata are drawn inside the archive band, the media bands and the channel lanes,
so every zoom transition is one object's layers gliding apart.

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

### Motion & "lock-in" (`timeline/camera.ts`)

The rule is **the user drives, the system polishes**. Direct manipulation
(wheel, pinch, drag) moves a *target* the live value eases toward exponentially —
instant response, momentum on release, and the cursor-anchored time stays pinned
for the whole glide. Input gain is tuned so the full years → hours journey is
about 26 mouse-wheel notches of honest, continuous driving.

Autonomous moves are deliberately different. Detents, double-click flights and
date jumps run as **timed flights** with a cubic ease-in-out whose duration
scales with distance — velocity-continuous, never a slam — and any user input
cancels them instantly. The **magnetic detent** is a *finisher*, not an
autopilot: if input goes idle mid-crossfade (after ~420 ms, longer than a slow
wheel cadence), it completes the transition just past the band edge in the
direction you were heading. It never travels to a distant zoom level on its
own — that's what **double-click** is for, which flies to the next resolved
plateau (whole archive / media bands / channel lanes / programmes) in one
motion. If you're already resting on a clean state, nothing moves.

### Why broadcast hours, not programme count

The zoomed-out terrain encodes *amount of broadcast time* per bucket, normalised
per track. Programme count is misleading (a day of short clips would outshine a
day of long broadcasts); broadcast hours answer the real question — *how much
archive material exists here?*

## Relationship to the real archive

The prototype generates data client-side. The production shape, per the brief, is
a **temporal tile server**: the frontend requests only the current viewport
(`{ start, end, msPerPixel, visibleTracks, overlays }`) and the backend returns
aggregate density when zoomed out or individual programme spans when zoomed in —
the same "send tiles, not the whole world" model as a map engine. The aggregate
levels in `data/aggregate.ts` mirror what would be precomputed server-side.

## Deliberately out of scope (next steps)

Thumbnails, historical-event curation, 3D, rerun-collapsing, transcripts, full
channel hierarchy, and timezone/broadcast-day handling are intentionally deferred.
The first goal is only: *does moving through DR archive time feel good?*
