import { Application, Container, Graphics } from "pixi.js";
import type { AggregateIndex, TrackLOD } from "../data/aggregate";
import type { ArchiveData } from "../data/generate";
import type { AggregateLevel, ProgrammeInstance } from "../data/types";
import { computeLayout, GUTTER_W, RULER_H, type RenderTrack } from "./layout";
import type { Store } from "./store";
import { TextPool } from "./textpool";
import { computeTicks } from "./ticks";
import { clamp, computeZoomState, MS } from "./zoom";

// ── palette ──────────────────────────────────────────────────────────────
const BG = 0x0e1117;
const GUTTER_BG = 0x141a23;
const RULER_BG = 0x121821;
const HAIR = 0x222b38;
const TEXT_DIM = 0x8b95a7;
const TEXT_BRIGHT = 0xd7dee9;
const COL_ARCHIVE = 0x6c7a91;
const COL_TV = 0x49b3c6;
const COL_RADIO = 0xe0964a;
const COL_NEWS = 0xffd166;
const COL_SEARCH = 0x74e0ff;
const COL_SELECT = 0xffffff;

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

/** Pick the aggregate level whose buckets are wide enough to read as terrain. */
function levelForScale(msPerPixel: number): AggregateLevel {
  if (MS.day / msPerPixel >= 2.5) return "day";
  if ((30 * MS.day) / msPerPixel >= 8) return "month";
  return "year";
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

    this.app.ticker.add(() => this.draw());
  }

  resize(width: number, height: number) {
    this.app.renderer.resize(width, height);
    this.store.camera.setViewport(width, height);
  }

  destroy() {
    this.app.destroy(true, { children: true });
  }

  // ── per-frame draw ───────────────────────────────────────────────────────
  private draw() {
    const cam = this.store.camera;
    const z = computeZoomState(cam.msPerPixel);
    const layout = computeLayout(cam, z);
    this.channelRects = layout.tracks.filter((t) => t.kind === "channel");

    const ribbon = this.ribbonG.clear();
    const bars = this.barsG.clear();
    const overlay = this.overlayG.clear();

    const viewStart = cam.viewStartMs;
    const viewEnd = cam.viewEndMs;
    const level = levelForScale(cam.msPerPixel);

    this.titlePool.begin();

    for (const track of layout.tracks) {
      if (track.alpha < 0.01) continue;
      if (track.kind === "channel") {
        // Aggregate ribbon resolves into individual programme bars.
        const ribbonAlpha = track.alpha * (1 - z.pProgramme);
        if (ribbonAlpha > 0.01) {
          this.drawRibbon(ribbon, track, level, viewStart, viewEnd, ribbonAlpha);
        }
        if (z.pProgramme > 0.01) {
          this.drawProgrammes(bars, overlay, track, viewStart, viewEnd, z.pProgramme, z.pLabels);
        }
        this.drawLaunchHatch(overlay, track);
      } else {
        // Archive / TV / Radio aggregate density bands.
        this.drawRibbon(ribbon, track, level, viewStart, viewEnd, track.alpha);
        if (this.store.state.showNews) this.drawNewsTerrain(overlay, track, level, viewStart, viewEnd, track.alpha);
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

      // Labels only when the bar is wide enough and there's room.
      if (pLabels > 0.02 && w > 46) {
        this.titlePool.next(p.title, drawX + 6, cy - 7, pLabels * Math.min(1, a + 0.4), TEXT_BRIGHT);
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
    overlay.rect(x0, track.y + 2, x1 - x0, Math.max(2, track.h - 4)).fill({ color: 0x2a3340, alpha: 0.28 * track.alpha });
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
      g.rect(x, RULER_H, 1, cam.viewportHeight - RULER_H).fill({ color: HAIR, alpha: t.major ? 0.5 : 0.28 });
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
      const tint = track.kind === "channel" ? TEXT_BRIGHT : 0xffffff;
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
      g.rect(x, RULER_H - 7, 1, 7).fill({ color: HAIR, alpha: t.major ? 0.9 : 0.5 });
      this.rulerPool.next(t.label, x + 4, 9, t.major ? 1 : 0.7, t.major ? TEXT_BRIGHT : TEXT_DIM);
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
      g.roundRect(cam.viewportWidth - 7, ty, 4, thumbH, 2).fill({ color: 0x4a5568, alpha: 0.6 * z.pChannel });
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
    const cam = this.store.camera;
    cam.msPerPixel = clamp(msPerPixel, cam.minMsPerPixel, cam.maxMsPerPixel);
    cam.centerTimeMs = timeMs;
    cam.setViewport(cam.viewportWidth, cam.viewportHeight);
  }

}
