import { ARCHIVE_END_MS, ARCHIVE_START_MS } from "../data/channels";
import { BANDS, clamp, zoomValue } from "./zoom";

// A virtual camera: time on x, tracks on y. The state is intentionally tiny.
// All pan/zoom interaction mutates this; the renderer reads it every frame.
//
// Motion model: every interaction sets a *target*; `update(dt)` eases the live
// value toward it each frame so nothing ever pops. Two ideas make the zoom feel
// physical rather than mechanical:
//   1. cursor-anchored glide — the time under the cursor stays pinned for the
//      whole eased zoom, not just the instant of input;
//   2. magnetic detents — when input goes idle, the target snaps to the nearest
//      "resolved" zoom plateau, so the archive always comes to rest fully
//      resolved (whole archive / media bands / channel lanes / programmes) and
//      never freezes mid-crossfade.

const SPAN = ARCHIVE_END_MS - ARCHIVE_START_MS;
const PAD = SPAN * 0.04; // a little breathing room past the archive edges

// Easing time-constants (ms). Smaller = snappier. Tuned by feel.
const ZOOM_TAU = 95;
const PAN_TAU = 120;
const SCROLL_TAU = 120;
// Idle before the zoom settles onto its nearest detent ("lock in").
const IDLE_SNAP_MS = 180;
// Velocity decay for pan/scroll fling.
const FLING_TAU = 220;

/** 1 - e^(-dt/tau): the fraction of the remaining gap to close this frame. */
const easeFactor = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

// Resolved zoom plateaus, in zoom-value units, where the view reads as one
// clean state. Centres of the gaps between transition bands (see zoom.ts).
const PLATEAU_ZOOMS = [
  BANDS.archiveToMedia[0] - 0.4, // whole archive, before it starts splitting
  (BANDS.archiveToMedia[1] + BANDS.mediaToChannel[0]) / 2, // TV / Radio bands
  (BANDS.mediaToChannel[1] + BANDS.aggregateToProgramme[0]) / 2, // channel lanes
  BANDS.labels[1] + 0.2, // programme bars with titles
  BANDS.metadata[1], // rich per-programme detail
];

// The crossfade ranges where the view is mid-resolve (and looks muddy if it
// comes to rest here). Sub-detail fades (labels, metadata) are deliberately
// excluded — resting part-way through them looks fine.
const TRANSITION_BANDS = [BANDS.archiveToMedia, BANDS.mediaToChannel, BANDS.aggregateToProgramme];

export class Camera {
  centerTimeMs: number;
  msPerPixel: number;
  scrollY = 0;
  viewportWidth = 1000;
  viewportHeight = 600;
  /** Height of the scrollable track content; set by the layout each frame. */
  contentHeight = 600;

  // Targets the live values ease toward.
  private targetMsPerPixel: number;
  private targetCenterTimeMs: number;
  private targetScrollY = 0;

  // Cursor anchor for a glide-zoom: keep `anchorTime` pinned under `anchorX`.
  private anchorX: number | null = null;
  private anchorTime = 0;

  // Fling velocities (px per ms of input), decayed each frame after release.
  private velCenterMsPerMs = 0; // time-axis velocity, in archive-ms per ms
  private velScrollPxPerMs = 0;

  private idleMs = 0;
  private interacting = false;
  private snapEnabled = true;
  private lastZoomDir = 0; // +1 zooming in, -1 zooming out, 0 none

  /** Tightest zoom-in: ~25 minutes per 1000px (a single news bar fills view). */
  minMsPerPixel = (25 * 60_000) / 1000;
  /** Loosest zoom-out: whole archive plus padding fits the viewport. */
  maxMsPerPixel = (SPAN + 2 * PAD) / 1000;

  constructor() {
    this.centerTimeMs = ARCHIVE_START_MS + SPAN / 2;
    this.msPerPixel = this.maxMsPerPixel;
    this.targetMsPerPixel = this.msPerPixel;
    this.targetCenterTimeMs = this.centerTimeMs;
  }

  setViewport(w: number, h: number) {
    this.viewportWidth = w;
    this.viewportHeight = h;
    // maxMsPerPixel is defined for 1000px; rescale to actual width.
    this.maxMsPerPixel = (SPAN + 2 * PAD) / Math.max(300, w);
    this.msPerPixel = clamp(this.msPerPixel, this.minMsPerPixel, this.maxMsPerPixel);
    this.targetMsPerPixel = clamp(this.targetMsPerPixel, this.minMsPerPixel, this.maxMsPerPixel);
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

  // ── input: each call records intent, motion is applied in update() ─────────

  /** Begin a continuous gesture (drag/pinch): suppress detents, kill fling. */
  beginGesture() {
    this.interacting = true;
    this.idleMs = 0;
    this.velCenterMsPerMs = 0;
    this.velScrollPxPerMs = 0;
    this.anchorX = null;
  }

  /** End a continuous gesture: re-enable detents and let any fling decay. */
  endGesture() {
    this.interacting = false;
    this.idleMs = 0;
  }

  /** Pan by a pixel delta (drag) — immediate, 1:1 with the finger. */
  panByPixels(dxPixels: number, dtMs = 16) {
    const dCenter = -dxPixels * this.msPerPixel;
    this.centerTimeMs += dCenter;
    this.targetCenterTimeMs = this.centerTimeMs;
    if (dtMs > 0) this.velCenterMsPerMs = dCenter / dtMs;
    this.anchorX = null;
    this.idleMs = 0;
    this.clampCenter();
  }

  scrollByPixels(dyPixels: number, dtMs = 16) {
    this.scrollY += dyPixels;
    this.targetScrollY = this.scrollY;
    if (dtMs > 0) this.velScrollPxPerMs = dyPixels / dtMs;
    this.idleMs = 0;
    this.clampScroll();
  }

  /** Zoom toward a target scale while keeping the time under `anchorX` pinned. */
  zoomAt(anchorX: number, factor: number) {
    this.anchorX = anchorX;
    this.anchorTime = this.xToTime(anchorX);
    this.targetMsPerPixel = clamp(this.targetMsPerPixel * factor, this.minMsPerPixel, this.maxMsPerPixel);
    if (factor < 1) this.lastZoomDir = 1; // fewer ms/px = zooming in
    else if (factor > 1) this.lastZoomDir = -1;
    this.idleMs = 0;
  }

  // ── per-frame integration ──────────────────────────────────────────────────
  update(dtMs: number) {
    const dt = clamp(dtMs, 1, 64); // guard against tab-switch frame spikes

    // Idle accounting drives the magnetic detent ("lock in").
    if (!this.interacting) this.idleMs += dt;
    if (!this.interacting && this.snapEnabled && this.idleMs >= IDLE_SNAP_MS) {
      this.snapTargetToDetent();
    }

    // Zoom: ease msPerPixel toward target, keeping the anchor time pinned.
    const zf = easeFactor(dt, ZOOM_TAU);
    const prevMpp = this.msPerPixel;
    this.msPerPixel += (this.targetMsPerPixel - this.msPerPixel) * zf;
    this.msPerPixel = clamp(this.msPerPixel, this.minMsPerPixel, this.maxMsPerPixel);
    const zoomMoving = Math.abs(this.msPerPixel - prevMpp) > prevMpp * 1e-4;

    if (this.anchorX !== null) {
      // Re-derive center so the anchored time stays under the cursor as we glide.
      this.centerTimeMs = this.anchorTime - (this.anchorX - this.viewportWidth / 2) * this.msPerPixel;
      this.targetCenterTimeMs = this.centerTimeMs;
      this.clampCenter();
      // Release the anchor once the zoom has effectively settled.
      if (!zoomMoving && Math.abs(this.targetMsPerPixel - this.msPerPixel) < this.msPerPixel * 1e-3) {
        this.anchorX = null;
      }
    } else {
      // Horizontal fling: project the target ahead, then ease into it.
      if (!this.interacting && Math.abs(this.velCenterMsPerMs) > 0) {
        this.targetCenterTimeMs += this.velCenterMsPerMs * dt;
        this.velCenterMsPerMs *= Math.exp(-dt / FLING_TAU);
        if (Math.abs(this.velCenterMsPerMs * dt) < this.msPerPixel * 0.05) this.velCenterMsPerMs = 0;
      }
      this.centerTimeMs += (this.targetCenterTimeMs - this.centerTimeMs) * easeFactor(dt, PAN_TAU);
      this.clampCenter();
    }

    // Vertical fling + ease.
    if (!this.interacting && Math.abs(this.velScrollPxPerMs) > 0) {
      this.targetScrollY += this.velScrollPxPerMs * dt;
      this.velScrollPxPerMs *= Math.exp(-dt / FLING_TAU);
      if (Math.abs(this.velScrollPxPerMs * dt) < 0.05) this.velScrollPxPerMs = 0;
    }
    this.scrollY += (this.targetScrollY - this.scrollY) * easeFactor(dt, SCROLL_TAU);
    this.clampScroll();
  }

  /**
   * If the zoom target is caught mid-transition (a half-split, muddy state),
   * pull it onto the nearest resolved plateau. If it's already resolved, leave
   * it — we only "lock in", we don't drag the camera off a clean rest.
   */
  private snapTargetToDetent() {
    const z = zoomValue(this.targetMsPerPixel);
    const band = TRANSITION_BANDS.find((b) => z > b[0] + 0.02 && z < b[1] - 0.02);
    if (!band) return; // already resting on a resolved plateau — leave it

    const minZ = zoomValue(this.maxMsPerPixel);
    const maxZ = zoomValue(this.minMsPerPixel);
    // Complete the transition in the direction the user was heading, so a small
    // zoom *finishes* into the next level rather than springing back. Falls back
    // to the nearer plateau if there's no recorded direction.
    let dest: number;
    if (this.lastZoomDir > 0) {
      dest = Math.min(...PLATEAU_ZOOMS.filter((p) => p >= band[1] - 0.01));
    } else if (this.lastZoomDir < 0) {
      dest = Math.max(...PLATEAU_ZOOMS.filter((p) => p <= band[0] + 0.01));
    } else {
      dest = PLATEAU_ZOOMS.reduce((a, b) => (Math.abs(b - z) < Math.abs(a - z) ? b : a));
    }
    if (!Number.isFinite(dest)) return;
    dest = clamp(dest, minZ, maxZ);
    if (Math.abs(dest - z) < 1e-3) return;
    // zoom = log2(BASE / mpp)  ⇒  mpp = maxMpp · 2^(minZ − dest).
    this.targetMsPerPixel = clamp(this.maxMsPerPixel * Math.pow(2, minZ - dest), this.minMsPerPixel, this.maxMsPerPixel);
    // Settle around what the viewer is looking at: pin the centred time.
    if (this.anchorX === null) {
      this.anchorX = this.viewportWidth / 2;
      this.anchorTime = this.centerTimeMs;
    }
  }

  private clampCenter() {
    const half = (this.viewportWidth / 2) * this.msPerPixel;
    const lo = ARCHIVE_START_MS - PAD + half;
    const hi = ARCHIVE_END_MS + PAD - half;
    this.centerTimeMs = lo <= hi ? clamp(this.centerTimeMs, lo, hi) : (ARCHIVE_START_MS + ARCHIVE_END_MS) / 2;
  }

  private clampScroll() {
    const maxScroll = Math.max(0, this.contentHeight - this.viewportHeight);
    this.scrollY = clamp(this.scrollY, 0, maxScroll);
    this.targetScrollY = clamp(this.targetScrollY, 0, maxScroll);
  }

  /** Animate the camera to frame a given time at a given scale (date jump). */
  flyTo(timeMs: number, msPerPixel: number) {
    this.targetMsPerPixel = clamp(msPerPixel, this.minMsPerPixel, this.maxMsPerPixel);
    this.targetCenterTimeMs = timeMs;
    this.anchorX = null;
    this.velCenterMsPerMs = 0;
    this.velScrollPxPerMs = 0;
    this.idleMs = 0;
  }
}
