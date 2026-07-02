import { Application, Container, Graphics } from "pixi.js";
import type { AggregateIndex, TrackLOD } from "../data/aggregate";
import type { ArchiveData } from "../data/generate";
import type { AggregateLevel, ProgrammeInstance } from "../data/types";
import { computeLayout, GUTTER_W, RULER_H, type RenderTrack } from "./layout";
import type { Store } from "./store";
import { TextPool } from "./textpool";
import { computeTicks } from "./ticks";
import { clamp, computeZoomState, MS, smoothstep } from "./zoom";

// ── palette ────────────────────────────────────────────────────────────────
// "Parchment & ink": a light, warm Royal-Library palette. Density now reads as
// ink laid down on paper (more broadcast time = more saturated), the inverse of
// the old dark heatmap. Text is dark ink; one brass gold + DR red carry accents.
const BG = 0xf4eee2; // warm parchment
const GUTTER_BG = 0xefe7d6; // a touch deeper paper
const RULER_BG = 0xf1ead9;
const HAIR = 0xd9cdb6; // muted taupe rule
const TEXT_DIM = 0x7c715c; // soft brown-grey
const TEXT_BRIGHT = 0x2c2620; // warm near-black ink
const COL_ARCHIVE = 0x8a7d66; // whole-archive terrain (muted taupe ink)
const COL_TV = 0x3f6e8c; // muted petrol blue
const COL_RADIO = 0xb0743a; // muted terracotta
const COL_NEWS = 0xb08832; // brass gold
const COL_SEARCH = 0x1f8a86; // deep teal
const COL_SELECT = 0x211c15; // ink ring (high contrast on paper)

const mediaColor = (t?: string) => (t === "tv" ? COL_TV : t === "radio" ? COL_RADIO : COL_ARCHIVE);

function lowerBound<T>(arr: T[], key: (t: T) => number, value: number): number {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(arr[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Continuous level-of-detail: finer aggregate levels crossfade in as their
 * buckets gain pixel width, instead of the whole terrain re-chunking in a
 * single frame at a hard threshold.
 */
interface LevelBlend {
  a: AggregateLevel;
  b: AggregateLevel | null;
  /** 0..1 blend from a to b. */
  t: number;
}

function levelBlend(msPerPixel: number): LevelBlend {
  const fDay = smoothstep(2, 4.5, MS.day / msPerPixel);
  if (fDay >= 1) return { a: "day", b: null, t: 0 };
  if (fDay > 0) return { a: "month", b: "day", t: fDay };
  const fMonth = smoothstep(5, 11, (30 * MS.day) / msPerPixel);
  if (fMonth >= 1) return { a: "month", b: null, t: 0 };
  if (fMonth > 0) return { a: "year", b: "month", t: fMonth };
  return { a: "year", b: null, t: 0 };
}

export class TimelineRenderer {
  app = new Application();
  private root = new Container();
  private ribbonG = new Graphics();
  private barsG = new Graphics();
  private overlayG = new Graphics();
  private chromeG = new Graphics(); // gutter + ruler panels + gridlines
  private titlePool!: TextPool;
  private gutterPool!: TextPool;
  private rulerPool!: TextPool;

  private hoveredProgramme: ProgrammeInstance | null = null;
  /** Cache of last frame's channel lane rects for hit-testing. */
  private channelRects: RenderTrack[] = [];

  constructor(
    private data: ArchiveData,
    private agg: AggregateIndex,
    private store: Store,
  ) {}

  async init(canvas: HTMLCanvasElement, width: number, height: number) {
    await this.app.init({
      canvas,
      width,
      height,
      background: BG,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    this.store.camera.setViewport(width, height);

    this.root.addChild(this.ribbonG, this.barsG, this.overlayG, this.chromeG);
    this.app.stage.addChild(this.root);

    this.titlePool = new TextPool(this.root, { fill: 0xffffff, fontSize: 12, fontFamily: "system-ui, sans-serif" });
    this.gutterPool = new TextPool(this.root, { fill: 0xffffff, fontSize: 13, fontFamily: "system-ui, sans-serif" });
    this.rulerPool = new TextPool(this.root, { fill: 0xffffff, fontSize: 11, fontFamily: "system-ui, sans-serif" });

    this.app.ticker.add((ticker) => this.draw(ticker.deltaMS));
  }

  resize(width: number, height: number) {
    this.app.renderer.resize(width, height);
    this.store.camera.setViewport(width, height);
  }

  destroy() {
    this.app.destroy(true, { children: true });
  }

  // ── per-frame draw ───────────────────────────────────────────────────────
  private draw(dtMs: number) {
    const cam = this.store.camera;
    cam.update(dtMs);
    const z = computeZoomState(cam.msPerPixel);
    const layout = computeLayout(cam, z);
    this.channelRects = layout.tracks.filter((t) => t.kind === "channel");

    const ribbon = this.ribbonG.clear();
    const bars = this.barsG.clear();
    const overlay = this.overlayG.clear();

    const viewStart = cam.viewStartMs;
    const viewEnd = cam.viewEndMs;
    const lod = levelBlend(cam.msPerPixel);

    this.titlePool.begin();

    for (const track of layout.tracks) {
      if (track.alpha < 0.01) continue;
      if (track.kind === "channel") {
        // Aggregate ribbon resolves into individual programme bars.
        const ribbonAlpha = track.alpha * (1 - z.pProgramme);
        if (ribbonAlpha > 0.01) {
          this.drawRibbon(ribbon, track, lod.a, viewStart, viewEnd, ribbonAlpha * (lod.b ? 1 - lod.t : 1));
          if (lod.b && lod.t > 0.02) this.drawRibbon(ribbon, track, lod.b, viewStart, viewEnd, ribbonAlpha * lod.t);
        }
        if (z.pProgramme > 0.01) {
          this.drawProgrammes(bars, overlay, track, viewStart, viewEnd, z.pProgramme, z.pLabels);
        }
        this.drawLaunchHatch(overlay, track);
      } else {
        // Archive / TV / Radio aggregate density bands — a smooth terrain ridge.
        this.drawRidge(ribbon, track, lod.a, viewStart, viewEnd, track.alpha * (lod.b ? 1 - lod.t : 1));
        if (lod.b && lod.t > 0.02) this.drawRidge(ribbon, track, lod.b, viewStart, viewEnd, track.alpha * lod.t);
        if (this.store.state.showNews) {
          this.drawNewsTerrain(overlay, track, lod.a, viewStart, viewEnd, track.alpha * (lod.b ? 1 - lod.t : 1));
          if (lod.b && lod.t > 0.02) this.drawNewsTerrain(overlay, track, lod.b, viewStart, viewEnd, track.alpha * lod.t);
        }
      }
    }

    // Search hit markers light up clusters at aggregate zoom.
    if (this.store.matchedSorted.length && z.pProgramme < 0.6) {
      this.drawSearchTerrain(overlay, viewStart, viewEnd, 1 - z.pProgramme);
    }

    this.titlePool.end();
    this.drawChrome(z, layout, viewStart, viewEnd);
  }

  private drawRibbon(
    g: Graphics,
    track: RenderTrack,
    level: AggregateLevel,
    viewStart: number,
    viewEnd: number,
    alpha: number,
  ) {
    const cam = this.store.camera;
    const lod = this.agg.get(track.trackId);
    if (!lod) return;
    const series = lod[level];
    const max = (lod.max as Record<AggregateLevel, number>)[level] || 1;
    const buckets = series.buckets;
    const base = mediaColor(track.mediaType);

    const top = track.y + 2;
    const h = Math.max(2, track.h - 4);

    let i = Math.max(0, lowerBound(buckets, (b) => b.endMs, viewStart) - 1);
    for (; i < buckets.length; i++) {
      const b = buckets[i];
      if (b.startMs > viewEnd) break;
      const x = cam.timeToX(b.startMs);
      const w = Math.max(1, (b.endMs - b.startMs) / cam.msPerPixel);
      if (x + w < GUTTER_W) continue;
      // Brightness encodes broadcast hours (the base terrain metric).
      const t = Math.pow(clamp(b.broadcastMs / max, 0, 1), 0.6);
      g.rect(x, top, w + 0.5, h).fill({ color: base, alpha: alpha * (0.12 + 0.82 * t) });
    }
  }

  /**
   * Tall aggregate bands (Archive / TV / Radio) drawn as a smooth terrain ridge:
   * height encodes broadcast hours, filled soft with a brighter crest line. Far
   * calmer than a wall of per-bucket rectangles, and the metaphor reads instantly
   * — more material = taller, denser ground.
   */
  private drawRidge(
    g: Graphics,
    track: RenderTrack,
    level: AggregateLevel,
    viewStart: number,
    viewEnd: number,
    alpha: number,
  ) {
    const cam = this.store.camera;
    const lod = this.agg.get(track.trackId);
    if (!lod) return;
    const buckets = lod[level].buckets;
    const max = (lod.max as Record<AggregateLevel, number>)[level] || 1;
    const base = mediaColor(track.mediaType);

    const baseY = track.y + track.h - 3;
    const usableH = Math.max(8, track.h - 9);

    const top: number[] = [];
    let i = Math.max(0, lowerBound(buckets, (b) => b.endMs, viewStart) - 1);
    for (; i < buckets.length; i++) {
      const b = buckets[i];
      if (b.startMs > viewEnd) break;
      const xMid = Math.max(GUTTER_W, cam.timeToX((b.startMs + b.endMs) / 2));
      const t = Math.pow(clamp(b.broadcastMs / max, 0, 1), 0.6);
      top.push(xMid, baseY - t * usableH);
    }
    if (top.length < 4) return;

    const firstX = top[0];
    const lastX = top[top.length - 2];
    // Filled body down to the baseline, then a crisp crest line on top.
    g.poly([firstX, baseY, ...top, lastX, baseY]).fill({ color: base, alpha: alpha * 0.5 });
    g.poly(top, false).stroke({ width: 1.5, color: base, alpha: alpha * 0.85 });
  }

  private drawProgrammes(
    bars: Graphics,
    overlay: Graphics,
    track: RenderTrack,
    viewStart: number,
    viewEnd: number,
    pProg: number,
    pLabels: number,
  ) {
    const cam = this.store.camera;
    const list = this.data.byChannel.get(track.trackId);
    if (!list) return;
    const st = this.store.state;
    const queryActive = this.store.matchedSorted.length > 0;

    const laneH = track.h;
    const innerH = Math.max(4, laneH - 8);
    const barH = innerH * (0.18 + 0.82 * pProg);
    const cy = track.y + laneH / 2;
    const y = cy - barH / 2;
    const r = Math.min(4, barH / 2);

    let i = Math.max(0, lowerBound(list, (p) => p.endMs, viewStart) - 1);
    for (; i < list.length; i++) {
      const p = list[i];
      if (p.startMs > viewEnd) break;
      const x = cam.timeToX(p.startMs);
      let w = (p.endMs - p.startMs) / cam.msPerPixel;
      if (x + w < GUTTER_W || w <= 0) continue;
      const drawX = Math.max(x, GUTTER_W);
      w = w - (drawX - x);
      if (w < 0.6) w = 0.6;

      const color = mediaColor(p.mediaType);
      const isNews = st.showNews && p.genre === "nyheder";
      const isMatch = queryActive && this.store.matchedIds.has(p.id);

      // Availability: solid = playable, dim = restricted, faint = unknown.
      let a = pProg;
      if (p.access === "restricted") a *= st.dimRestricted ? 0.22 : 0.42;
      else if (p.access === "unknown") a *= 0.55;
      else if (p.access === "metadata_only") a *= 0.75;
      if (queryActive && !isMatch) a *= 0.32;

      const gap = w > 3 ? 0.5 : 0;
      bars.roundRect(drawX, y, Math.max(0.6, w - gap), barH, r).fill({ color, alpha: a });

      // metadata_only reads as an outline rather than a solid fill.
      if (p.access === "metadata_only" && w > 3) {
        bars.roundRect(drawX, y, w - gap, barH, r).stroke({ width: 1, color, alpha: pProg * 0.7 });
      }

      if (isNews && w > 2) {
        overlay.roundRect(drawX - 1, y - 1, w - gap + 2, barH + 2, r).stroke({ width: 1.5, color: COL_NEWS, alpha: pProg });
      }
      if (isMatch) {
        overlay.roundRect(drawX - 1.5, y - 1.5, w - gap + 3, barH + 3, r + 1).stroke({ width: 2, color: COL_SEARCH, alpha: 0.95 });
      }
      if (st.selected && st.selected.id === p.id) {
        overlay.roundRect(drawX - 2, y - 2, w - gap + 4, barH + 4, r + 1).stroke({ width: 2, color: COL_SELECT, alpha: 1 });
      }

      // Labels fade in with bar width (no pop at a hard pixel gate) — and are
      // clipped to the bar so titles never bleed across neighbours.
      if (pLabels > 0.02 && w > 40) {
        const widthAlpha = smoothstep(40, 72, w);
        const budget = Math.floor((w - 14) / 6.4);
        if (budget >= 3 && widthAlpha > 0.02) {
          const label = p.title.length > budget ? p.title.slice(0, budget - 1) + "…" : p.title;
          this.titlePool.next(label, drawX + 6, cy - 7, pLabels * widthAlpha * Math.min(1, a + 0.4), TEXT_BRIGHT);
        }
      }
    }
  }

  /** A subtle hatch over the period before a channel launched (lane stays put). */
  private drawLaunchHatch(overlay: Graphics, track: RenderTrack) {
    const c = track.channel;
    if (!c) return;
    const cam = this.store.camera;
    const launchX = cam.timeToX(c.activeFromMs);
    if (launchX <= GUTTER_W) return;
    const x0 = GUTTER_W;
    const x1 = Math.min(launchX, cam.viewportWidth);
    if (x1 <= x0) return;
    overlay.rect(x0, track.y + 2, x1 - x0, Math.max(2, track.h - 4)).fill({ color: 0xb8ac92, alpha: 0.3 * track.alpha });
  }

  private drawNewsTerrain(
    overlay: Graphics,
    track: RenderTrack,
    level: AggregateLevel,
    viewStart: number,
    viewEnd: number,
    alpha: number,
  ) {
    const cam = this.store.camera;
    const lod = this.agg.get(track.trackId) as TrackLOD | undefined;
    if (!lod) return;
    const buckets = lod[level].buckets;
    let maxNews = 1;
    for (const b of buckets) maxNews = Math.max(maxNews, b.newsCount);
    let i = Math.max(0, lowerBound(buckets, (b) => b.endMs, viewStart) - 1);
    for (; i < buckets.length; i++) {
      const b = buckets[i];
      if (b.startMs > viewEnd) break;
      if (!b.newsCount) continue;
      const x = cam.timeToX(b.startMs);
      const w = Math.max(1, (b.endMs - b.startMs) / cam.msPerPixel);
      if (x + w < GUTTER_W) continue;
      const t = b.newsCount / maxNews;
      overlay.rect(x, track.y + 2, w + 0.5, 3).fill({ color: COL_NEWS, alpha: alpha * (0.2 + 0.7 * t) });
    }
  }

  private drawSearchTerrain(overlay: Graphics, viewStart: number, viewEnd: number, alpha: number) {
    const cam = this.store.camera;
    const list = this.store.matchedSorted;
    const top = RULER_H;
    const bottom = cam.viewportHeight;
    let i = lowerBound(list, (p) => p.startMs, viewStart);
    let drawn = 0;
    const limit = 5000;
    for (; i < list.length && drawn < limit; i++) {
      const p = list[i];
      if (p.startMs > viewEnd) break;
      const x = cam.timeToX(p.startMs);
      if (x < GUTTER_W) continue;
      overlay.rect(x, top, 1.4, bottom - top).fill({ color: COL_SEARCH, alpha: 0.1 * alpha });
      drawn++;
    }
  }

  // ── chrome: gutter, ruler, gridlines, labels ──────────────────────────────
  private drawChrome(
    z: ReturnType<typeof computeZoomState>,
    layout: ReturnType<typeof computeLayout>,
    viewStart: number,
    viewEnd: number,
  ) {
    const cam = this.store.camera;
    const g = this.chromeG.clear();
    const ticks = computeTicks(viewStart, viewEnd, cam.msPerPixel);

    this.rulerPool.begin();
    this.gutterPool.begin();

    // Vertical gridlines behind nothing else (drawn over content but faint).
    for (const t of ticks) {
      const x = cam.timeToX(t.ms);
      if (x < GUTTER_W || x > cam.viewportWidth) continue;
      g.rect(x, RULER_H, 1, cam.viewportHeight - RULER_H).fill({ color: HAIR, alpha: (t.major ? 0.45 : 0.18) * t.alpha });
    }

    // Left gutter panel (opaque — masks content scrolled/overflowing left).
    g.rect(0, 0, GUTTER_W, cam.viewportHeight).fill({ color: GUTTER_BG, alpha: 1 });
    g.rect(GUTTER_W - 1, 0, 1, cam.viewportHeight).fill({ color: HAIR, alpha: 1 });

    // Group headers (FJERNSYN / RADIO) at channel zoom.
    for (const gh of layout.groupHeaders) {
      if (gh.alpha < 0.02 || gh.y < RULER_H - 10 || gh.y > cam.viewportHeight) continue;
      this.gutterPool.next(gh.label, 12, gh.y + 6, gh.alpha * 0.9, TEXT_DIM);
    }

    // Track labels in the gutter.
    for (const track of layout.tracks) {
      if (track.labelAlpha < 0.02) continue;
      const cy = track.y + track.h / 2 - 8;
      if (cy < RULER_H - 12 || cy > cam.viewportHeight) continue;
      const tint = TEXT_BRIGHT;
      const swatch = mediaColor(track.mediaType);
      if (track.kind !== "archive") {
        g.rect(14, cy + 4, 8, 8).fill({ color: swatch, alpha: track.labelAlpha });
      }
      this.gutterPool.next(track.label, track.kind === "archive" ? 16 : 28, cy, track.labelAlpha, tint);
    }

    // Top ruler panel (opaque) + tick labels.
    g.rect(0, 0, cam.viewportWidth, RULER_H).fill({ color: RULER_BG, alpha: 1 });
    g.rect(0, RULER_H - 1, cam.viewportWidth, 1).fill({ color: HAIR, alpha: 1 });
    for (const t of ticks) {
      const x = cam.timeToX(t.ms);
      if (x < GUTTER_W - 4 || x > cam.viewportWidth) continue;
      g.rect(x, RULER_H - 7, 1, 7).fill({ color: HAIR, alpha: (t.major ? 0.9 : 0.5) * t.alpha });
      if (t.labelAlpha > 0.03) {
        this.rulerPool.next(t.label, x + 4, 9, (t.major ? 1 : 0.7) * t.labelAlpha, t.major ? TEXT_BRIGHT : TEXT_DIM);
      }
    }
    // Mask any ruler text that bled under the gutter.
    g.rect(0, 0, GUTTER_W, RULER_H).fill({ color: RULER_BG, alpha: 1 });
    this.gutterPool.next("Arkivkort", 14, 11, 0.85, TEXT_BRIGHT);

    // Vertical scrollbar when channel content overflows.
    if (z.pChannel > 0.5 && cam.contentHeight > cam.viewportHeight) {
      const trackH = cam.viewportHeight - RULER_H;
      const thumbH = Math.max(28, (trackH * trackH) / cam.contentHeight);
      const maxScroll = cam.contentHeight - cam.viewportHeight;
      const ty = RULER_H + (trackH - thumbH) * (cam.scrollY / maxScroll);
      g.roundRect(cam.viewportWidth - 7, ty, 4, thumbH, 2).fill({ color: 0x9a8d74, alpha: 0.6 * z.pChannel });
    }

    this.rulerPool.end();
    this.gutterPool.end();
  }

  // ── interaction helpers (called from the React wrapper) ────────────────────
  programmeAt(px: number, py: number): ProgrammeInstance | null {
    const cam = this.store.camera;
    const z = computeZoomState(cam.msPerPixel);
    if (z.pProgramme < 0.4 || px < GUTTER_W) return null;
    const lane = this.channelRects.find((t) => py >= t.y && py <= t.y + t.h);
    if (!lane) return null;
    const list = this.data.byChannel.get(lane.trackId);
    if (!list) return null;
    const t = cam.xToTime(px);
    // Programmes are non-overlapping and sorted by start, so the candidate is
    // the last one that started at or before t.
    const idx = lowerBound(list, (p) => p.startMs, t) - 1;
    if (idx >= 0 && idx < list.length) {
      const p = list[idx];
      if (t >= p.startMs && t <= p.endMs) return p;
    }
    return null;
  }

  setHovered(p: ProgrammeInstance | null) {
    this.hoveredProgramme = p;
  }
  getHovered() {
    return this.hoveredProgramme;
  }

  /** Animate the camera to frame a given time at a given scale (date jump). */
  flyTo(timeMs: number, msPerPixel: number) {
    this.store.camera.flyTo(timeMs, msPerPixel);
  }
}
