import { Application, Container, Graphics, Text } from "pixi.js";
import type { Archive } from "../data/archive";
import type { AggregateBucket, AggregateLevel, Channel, ProgrammeInstance } from "../data/types";
import { RADIO_CHANNELS, TV_CHANNELS } from "../data/channels";
import { computeLayout, GUTTER_W, RULER_H, type RenderTrack } from "./layout";
import type { Store } from "./store";
import { TextPool } from "./textpool";
import { computeTicks } from "./ticks";
import { clamp, computeZoomState, MS, smoothstep } from "./zoom";
import { DR_RED, INK, INK_DIM, inkFor, mixColor, PAPER_TEXT, pigment } from "./theme";

// Tidsrummet: the archive is one pigmented object on warm paper. The canvas is
// transparent — the page supplies the daylight gradient — and the CSS mask on
// the canvas fades everything out at the edges, so nothing has a border.
//
// Identity is carried by the material, never by written labels:
//   television = cool blue, hard bucket-cut blocks (the picture tube)
//   radio      = warm amber, a smooth continuous ribbon (the dial lamp)
// The same per-channel strata are drawn inside the archive band, the media
// bands and the channel lanes, so every zoom transition is one object's layers
// gliding apart — never a picture being swapped for another.

const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';
const GROT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const STRATUM_MAX_H = 16;
const STRATUM_GAP = 5;
const RECEDE = 0.12; // alpha multiplier for material outside an active lens

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

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class TimelineRenderer {
  app = new Application();
  private root = new Container();
  private watermark!: Text;
  private ribbonG = new Graphics();
  private barsG = new Graphics();
  private overlayG = new Graphics();
  private chromeG = new Graphics();
  private titlePool!: TextPool;
  private monoPool!: TextPool;
  private rulerPool!: TextPool;

  private hoveredProgramme: ProgrammeInstance | null = null;
  private pointerY = -1;
  /** Cache of last frame's channel lane rects for hit-testing. */
  private channelRects: RenderTrack[] = [];
  /** Screen rect of the lifted (selected) bar this frame, for the meta float. */
  private selectedRect: ScreenRect | null = null;
  private selCandidate: ScreenRect | null = null;
  private lastWatermarkText = "";

  constructor(
    private archive: Archive,
    private store: Store,
  ) {}

  async init(canvas: HTMLCanvasElement, width: number, height: number) {
    await this.app.init({
      canvas,
      width,
      height,
      backgroundAlpha: 0, // the page paints the daylight gradient
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    this.store.camera.setViewport(width, height);

    this.watermark = new Text({
      text: "",
      style: { fontFamily: SERIF, fontSize: 220, fontWeight: "500", fill: 0xffffff },
    });
    this.watermark.anchor.set(1, 0.5);
    this.watermark.tint = INK;
    this.watermark.resolution = 1.5;

    this.root.addChild(this.watermark, this.ribbonG, this.barsG, this.overlayG, this.chromeG);
    this.app.stage.addChild(this.root);

    this.titlePool = new TextPool(this.root, { fill: 0xffffff, fontSize: 12, fontFamily: GROT });
    this.monoPool = new TextPool(this.root, {
      fill: 0xffffff,
      fontSize: 10,
      fontFamily: GROT,
      fontWeight: "600",
      letterSpacing: 2,
      // A paper halo so the etched monogram stays readable over pigment.
      stroke: { color: 0xf6f1e6, width: 2, join: "round" },
    });
    this.rulerPool = new TextPool(this.root, { fill: 0xffffff, fontSize: 11, fontFamily: GROT });

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
    this.selCandidate = null;

    this.drawWatermark(z);
    this.titlePool.begin();
    this.monoPool.begin();

    for (const track of layout.tracks) {
      if (track.alpha < 0.01) continue;
      if (track.kind === "channel") {
        // Aggregate stratum resolves into individual programme bars.
        const ribbonAlpha = track.alpha * (1 - z.pProgramme);
        if (ribbonAlpha > 0.01 && track.channel) {
          this.drawStrataGroup(ribbon, [track.channel], track, ribbonAlpha, lod, viewStart, viewEnd);
        }
        if (z.pProgramme > 0.01) {
          this.drawProgrammes(bars, track, viewStart, viewEnd, z.pProgramme, z.pLabels);
        }
      } else if (track.kind === "media") {
        const channels = track.mediaType === "tv" ? TV_CHANNELS : RADIO_CHANNELS;
        this.drawStrataGroup(ribbon, channels, track, track.alpha, lod, viewStart, viewEnd);
      } else {
        // Whole archive: all ten strata, TV above radio, one object.
        this.drawStrataGroup(ribbon, [...TV_CHANNELS, ...RADIO_CHANNELS], track, track.alpha, lod, viewStart, viewEnd, TV_CHANNELS.length);
      }
    }

    this.drawSelectionLift(overlay, z);
    this.drawMonograms(layout, z);

    this.titlePool.end();
    this.monoPool.end();
    this.drawChrome(z, viewStart, viewEnd);
  }

  /** The current year, pressed faintly into the paper for orientation. */
  private drawWatermark(z: ReturnType<typeof computeZoomState>) {
    const cam = this.store.camera;
    const year = String(new Date(cam.centerTimeMs).getUTCFullYear());
    if (year !== this.lastWatermarkText) {
      this.watermark.text = year;
      this.lastWatermarkText = year;
    }
    // Cap by width too, so the year never spills past a narrow screen.
    const targetSize = Math.round(clamp(Math.min(cam.viewportHeight * 0.36, cam.viewportWidth * 0.4), 90, 280));
    if (Math.abs(this.watermark.style.fontSize - targetSize) > 4) this.watermark.style.fontSize = targetSize;
    this.watermark.x = cam.viewportWidth - 36;
    this.watermark.y = RULER_H + (cam.viewportHeight - RULER_H) / 2;
    this.watermark.alpha = 0.05 * z.pChannel;
    this.watermark.visible = this.watermark.alpha > 0.005;
  }

  /**
   * A stack of per-channel strata centred in a band rect. The same function
   * renders the archive band (all channels), the media bands (their channels)
   * and a single channel's aggregate ribbon — so zooming reads as the one
   * object's layers gliding apart, never a change of picture.
   */
  private drawStrataGroup(
    g: Graphics,
    channels: Channel[],
    track: RenderTrack,
    alpha: number,
    lod: LevelBlend,
    viewStart: number,
    viewEnd: number,
    splitAfter = -1,
  ) {
    const n = channels.length;
    const splitGap = splitAfter > 0 ? 16 : 0;
    const stratumH = clamp((track.h * 0.62 - (n - 1) * STRATUM_GAP - splitGap) / n, 5, STRATUM_MAX_H);
    const groupH = n * stratumH + (n - 1) * STRATUM_GAP + splitGap;
    let y = track.y + (track.h - groupH) / 2;

    for (let i = 0; i < n; i++) {
      if (i === splitAfter) y += splitGap;
      const c = channels[i];
      const rect = { y, h: stratumH };
      this.drawChannelStratum(g, c, rect, alpha * (lod.b ? 1 - lod.t : 1), lod.a, viewStart, viewEnd);
      if (lod.b && lod.t > 0.02) this.drawChannelStratum(g, c, rect, alpha * lod.t, lod.b, viewStart, viewEnd);
      y += stratumH + STRATUM_GAP;
    }
  }

  private drawChannelStratum(
    g: Graphics,
    channel: Channel,
    rect: { y: number; h: number },
    alpha: number,
    level: AggregateLevel,
    viewStart: number,
    viewEnd: number,
  ) {
    if (alpha < 0.01) return;
    const cam = this.store.camera;
    const lodData = this.archive.aggregates.get(channel.id);
    if (!lodData) return;
    const buckets = lodData[level].buckets;
    const max = lodData.max[level] || 1;
    const ink = inkFor(channel.mediaType);
    const st = this.store.state;
    const queryActive = this.store.queryActive;

    const fade = (b: AggregateBucket): number => {
      let a = alpha;
      if (queryActive) a *= this.store.bucketHasMatch(channel.id, b.startMs, b.endMs) ? 1 : RECEDE;
      if (st.showNews) a *= b.newsCount > 0 ? 1 : 0.25;
      return a;
    };

    let i = Math.max(0, lowerBound(buckets, (b) => b.endMs, viewStart) - 1);

    if (channel.mediaType === "tv") {
      // The picture tube: hard bucket-cut blocks; depth of pigment is density.
      const top = rect.y;
      const h = Math.max(2, rect.h);
      for (; i < buckets.length; i++) {
        const b = buckets[i];
        if (b.startMs > viewEnd) break;
        if (b.broadcastMs <= 0) continue;
        const x = cam.timeToX(b.startMs);
        const w = Math.max(1, (b.endMs - b.startMs) / cam.msPerPixel);
        if (x + w < 0) continue;
        // Density clusters near the top of the range, so spread it (^1.6)
        // to make the pigment actually vary along the band.
        const t = Math.pow(clamp(b.broadcastMs / max, 0, 1), 1.6);
        const gap = w > 4 ? 1 : 0;
        g.rect(x, top, w - gap + 0.5, h).fill({ color: pigment(ink, t), alpha: fade(b) * (0.3 + 0.7 * t) });
      }
    } else {
      // The dial lamp: a smooth continuous ribbon; thickness breathes with density.
      const cy = rect.y + rect.h / 2;
      const half = (t: number) => Math.max(0.6, (rect.h / 2) * (0.22 + 0.78 * t));
      const density = (b: AggregateBucket) =>
        b.broadcastMs > 0 ? Math.pow(clamp(b.broadcastMs / max, 0, 1), 1.3) : 0;
      const quad = (x0: number, t0: number, x1: number, t1: number, a: number) => {
        const tm = (t0 + t1) / 2;
        g.poly([x0, cy - half(t0), x1, cy - half(t1), x1, cy + half(t1), x0, cy + half(t0)]).fill({
          color: pigment(ink, tm),
          alpha: a * (0.55 + 0.45 * tm),
        });
      };
      let prev: { x: number; t: number; b: AggregateBucket } | null = null;
      for (; i < buckets.length; i++) {
        const b = buckets[i];
        if (b.startMs > viewEnd) break;
        const xMid = cam.timeToX((b.startMs + b.endMs) / 2);
        const t = density(b);
        if (!prev && t > 0) quad(cam.timeToX(b.startMs), t, xMid, t, fade(b)); // leading cap
        if (prev && xMid > prev.x && (prev.t > 0 || t > 0)) {
          quad(prev.x, prev.t, xMid, t, (fade(prev.b) + fade(b)) / 2);
        }
        prev = { x: xMid, t, b };
      }
      if (prev && prev.t > 0) quad(prev.x, prev.t, cam.timeToX(prev.b.endMs), prev.t, fade(prev.b)); // trailing cap
    }
  }

  private drawProgrammes(
    bars: Graphics,
    track: RenderTrack,
    viewStart: number,
    viewEnd: number,
    pProg: number,
    pLabels: number,
  ) {
    const cam = this.store.camera;
    const list = this.archive.range(track.trackId, viewStart, viewEnd);
    const st = this.store.state;
    const queryActive = this.store.queryActive;
    const ink = inkFor(track.mediaType);

    const laneH = track.h;
    const innerH = Math.max(4, laneH - 10);
    const barH = innerH * (0.18 + 0.82 * pProg) * 0.62;
    const cy = track.y + laneH / 2;
    const y = cy - barH / 2;
    const r = Math.min(5, barH / 2);

    for (const p of list) {
      if (p.startMs > viewEnd) break;
      const x = cam.timeToX(p.startMs);
      let w = (p.endMs - p.startMs) / cam.msPerPixel;
      if (x + w < 0 || w <= 0) continue;
      const drawX = Math.max(x, 0);
      w = w - (drawX - x);
      if (w < 0.6) w = 0.6;

      const isNews = p.genre === "nyheder";
      const isMatch = queryActive && this.store.matchesProgramme(p);

      // Lenses work by recession: everything outside them loses its pigment.
      let recede = 1;
      if (queryActive && !isMatch) recede *= RECEDE;
      if (st.showNews && !isNews) recede *= 0.18;

      const gap = w > 3 ? 0.5 : 0;
      const bw = Math.max(0.6, w - gap);
      const solid = p.access === "available";

      if (p.access === "metadata_only") {
        // Hollow outline: the record exists, the material does not.
        bars.roundRect(drawX, y, bw, barH, r).fill({ color: ink.base, alpha: pProg * recede * 0.05 });
        if (w > 3) bars.roundRect(drawX, y, bw, barH, r).stroke({ width: 1, color: ink.base, alpha: pProg * recede * 0.8 });
      } else if (p.access === "restricted") {
        const washed = st.dimRestricted ? 0.08 : 0.2;
        bars.roundRect(drawX, y, bw, barH, r).fill({ color: ink.base, alpha: pProg * recede * washed });
      } else if (p.access === "unknown") {
        bars.roundRect(drawX, y, bw, barH, r).fill({ color: ink.base, alpha: pProg * recede * 0.32 });
      } else {
        bars.roundRect(drawX, y, bw, barH, r).fill({ color: ink.base, alpha: pProg * recede });
      }

      if (this.hoveredProgramme && this.hoveredProgramme.id === p.id) {
        bars.roundRect(drawX, y, bw, barH, r).fill({ color: 0xffffff, alpha: pProg * 0.16 });
      }

      if (st.selected && st.selected.id === p.id) {
        this.selCandidate = { x: drawX, y, w: bw, h: barH };
      }

      // Labels fade in with bar width; ink on washes, paper on solid pigment.
      const labelBase = pLabels * recede;
      if (labelBase > 0.06 && w > 40) {
        const widthAlpha = smoothstep(40, 72, w);
        const budget = Math.floor((w - 14) / 6.4);
        if (budget >= 3 && widthAlpha > 0.02) {
          const label = p.title.length > budget ? p.title.slice(0, budget - 1) + "…" : p.title;
          const tint = solid ? PAPER_TEXT : INK;
          this.titlePool.next(label, drawX + 7, cy - 7, labelBase * widthAlpha, tint);
        }
      }
    }
  }

  /** The chosen broadcast lifts from the paper: deeper shadow, brighter
   *  pigment, and the product's only red drawn beneath it. */
  private drawSelectionLift(overlay: Graphics, z: ReturnType<typeof computeZoomState>) {
    const sel = this.store.state.selected;
    const c = this.selCandidate;
    if (!sel || !c || z.pProgramme < 0.4) {
      this.selectedRect = null;
      return;
    }
    const ink = inkFor(sel.mediaType);
    const r = Math.min(6, (c.h + 6) / 2);

    // A soft shadow, faked with three widening washes of ink.
    for (const s of [
      { pad: 12, dy: 13, a: 0.05 },
      { pad: 6, dy: 9, a: 0.08 },
      { pad: 2, dy: 5, a: 0.12 },
    ]) {
      overlay.roundRect(c.x - s.pad, c.y + s.dy, c.w + s.pad * 2, c.h + 6, r + s.pad / 2).fill({ color: INK, alpha: s.a });
    }
    overlay.roundRect(c.x - 2, c.y - 3, c.w + 4, c.h + 6, r).fill({ color: mixColor(ink.base, 0xffffff, 0.16), alpha: 1 });
    overlay.rect(c.x + c.w * 0.08, c.y + c.h + 7, c.w * 0.84, 2).fill({ color: DR_RED, alpha: 1 });

    this.selectedRect = { x: c.x - 2, y: c.y - 3, w: c.w + 4, h: c.h + 6 };
  }

  /** Channel monograms, etched into the left fade; they wake near the cursor. */
  private drawMonograms(layout: ReturnType<typeof computeLayout>, z: ReturnType<typeof computeZoomState>) {
    if (z.pChannel < 0.05) return;
    const cam = this.store.camera;
    for (const track of this.channelRects) {
      if (track.labelAlpha < 0.02) continue;
      // Sits in the quiet zone above the lane's bars, never on top of them.
      const ty = track.y + 3;
      if (ty < RULER_H - 6 || ty > cam.viewportHeight) continue;
      const near = this.pointerY >= track.y && this.pointerY <= track.y + track.h;
      const alpha = track.labelAlpha * (near ? 1 : 0.55);
      this.monoPool.next(track.label.toUpperCase(), 26, ty, alpha, near ? INK : INK_DIM);
    }
    void layout;
  }

  // ── chrome: frameless ruler, faint gridlines, hairline scroll thumb ───────
  private drawChrome(z: ReturnType<typeof computeZoomState>, viewStart: number, viewEnd: number) {
    const cam = this.store.camera;
    const g = this.chromeG.clear();
    const ticks = computeTicks(viewStart, viewEnd, cam.msPerPixel);

    this.rulerPool.begin();

    for (const t of ticks) {
      const x = cam.timeToX(t.ms);
      if (x < -4 || x > cam.viewportWidth) continue;
      // Gridlines: pressed into the paper, never a cage around the content.
      g.rect(x, RULER_H, 1, cam.viewportHeight - RULER_H).fill({ color: INK, alpha: (t.major ? 0.07 : 0.03) * t.alpha });
      g.rect(x, RULER_H - 8, 1, 8).fill({ color: INK, alpha: (t.major ? 0.4 : 0.2) * t.alpha });
      if (t.labelAlpha > 0.03) {
        this.rulerPool.next(t.label, x + 5, 9, (t.major ? 0.95 : 0.6) * t.labelAlpha, t.major ? INK : INK_DIM);
      }
    }

    // Vertical scroll thumb: one hairline, only when the world overflows.
    if (z.pChannel > 0.5 && cam.contentHeight > cam.viewportHeight + 1) {
      const trackH = cam.viewportHeight - RULER_H;
      const thumbH = Math.max(28, (trackH * trackH) / cam.contentHeight);
      const maxScroll = cam.contentHeight - cam.viewportHeight;
      const ty = RULER_H + (trackH - thumbH) * (cam.scrollY / maxScroll);
      g.roundRect(cam.viewportWidth - 5, ty, 2, thumbH, 1).fill({ color: INK, alpha: 0.25 * z.pChannel });
    }

    this.rulerPool.end();
  }

  // ── interaction helpers (called from the React wrapper) ────────────────────
  programmeAt(px: number, py: number): ProgrammeInstance | null {
    const cam = this.store.camera;
    const z = computeZoomState(cam.msPerPixel);
    if (z.pProgramme < 0.4 || px < GUTTER_W) return null;
    const lane = this.channelRects.find((t) => py >= t.y && py <= t.y + t.h);
    if (!lane) return null;
    return this.archive.at(lane.trackId, cam.xToTime(px));
  }

  setHovered(p: ProgrammeInstance | null) {
    this.hoveredProgramme = p;
  }
  getHovered() {
    return this.hoveredProgramme;
  }
  setPointer(_x: number, y: number) {
    this.pointerY = y;
  }
  /** Screen rect of the lifted selection, for the DOM meta float. */
  getSelectedRect(): ScreenRect | null {
    return this.selectedRect;
  }

  /** Animate the camera to frame a given time at a given scale (date jump). */
  flyTo(timeMs: number, msPerPixel: number) {
    this.store.camera.flyTo(timeMs, msPerPixel);
  }
}
