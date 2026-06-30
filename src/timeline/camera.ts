import { clamp } from "./zoom";

// A virtual camera: time on x, tracks on y. The state is intentionally tiny.
// All pan/zoom interaction mutates this; the renderer reads it every frame.
// Time bounds are injected so the same camera serves synthetic data (a 5-year
// slice) or the full live archive (1931–2025).

export class Camera {
  startMs: number;
  endMs: number;
  private span: number;
  private pad: number;

  centerTimeMs: number;
  msPerPixel: number;
  scrollY = 0;
  viewportWidth = 1000;
  viewportHeight = 600;
  /** Height of the scrollable track content; set by the layout each frame. */
  contentHeight = 600;

  /** Tightest zoom-in: ~25 minutes per 1000px (a single news bar fills view). */
  minMsPerPixel = (25 * 60_000) / 1000;
  maxMsPerPixel: number;

  constructor(bounds: { startMs: number; endMs: number }) {
    this.startMs = bounds.startMs;
    this.endMs = bounds.endMs;
    this.span = this.endMs - this.startMs;
    this.pad = this.span * 0.04;
    this.centerTimeMs = this.startMs + this.span / 2;
    this.maxMsPerPixel = (this.span + 2 * this.pad) / 1000;
    this.msPerPixel = this.maxMsPerPixel;
  }

  setViewport(w: number, h: number) {
    this.viewportWidth = w;
    this.viewportHeight = h;
    // maxMsPerPixel is defined for 1000px; rescale to actual width.
    this.maxMsPerPixel = (this.span + 2 * this.pad) / Math.max(300, w);
    this.msPerPixel = clamp(this.msPerPixel, this.minMsPerPixel, this.maxMsPerPixel);
    this.clampCenter();
    this.clampScroll();
  }

  timeToX(t: number): number {
    return (t - this.centerTimeMs) / this.msPerPixel + this.viewportWidth / 2;
  }

  xToTime(x: number): number {
    return this.centerTimeMs + (x - this.viewportWidth / 2) * this.msPerPixel;
  }

  get viewStartMs(): number {
    return this.xToTime(0);
  }
  get viewEndMs(): number {
    return this.xToTime(this.viewportWidth);
  }

  /** Pan by a pixel delta (drag). */
  panByPixels(dxPixels: number) {
    this.centerTimeMs -= dxPixels * this.msPerPixel;
    this.clampCenter();
  }

  scrollByPixels(dyPixels: number) {
    this.scrollY += dyPixels;
    this.clampScroll();
  }

  /** Zoom while keeping the time under `anchorX` pinned — the crucial detail. */
  zoomAt(anchorX: number, factor: number) {
    const anchorTime = this.xToTime(anchorX);
    this.msPerPixel = clamp(this.msPerPixel * factor, this.minMsPerPixel, this.maxMsPerPixel);
    // Re-derive center so anchorTime stays under anchorX.
    this.centerTimeMs = anchorTime - (anchorX - this.viewportWidth / 2) * this.msPerPixel;
    this.clampCenter();
  }

  private clampCenter() {
    const half = (this.viewportWidth / 2) * this.msPerPixel;
    const lo = this.startMs - this.pad + half;
    const hi = this.endMs + this.pad - half;
    this.centerTimeMs = lo <= hi ? clamp(this.centerTimeMs, lo, hi) : (this.startMs + this.endMs) / 2;
  }

  private clampScroll() {
    const maxScroll = Math.max(0, this.contentHeight - this.viewportHeight);
    this.scrollY = clamp(this.scrollY, 0, maxScroll);
  }
}
