import { ARCHIVE_END_MS, ARCHIVE_START_MS } from "../data/channels";
import { BANDS, clamp, mppForZoom, zoomValue } from "./zoom";

// A virtual camera: time on x, tracks on y. The state is intentionally tiny.
// All pan/zoom interaction mutates this; the renderer reads it every frame.
//
// Motion model — "the user drives, the system polishes":
//   * Direct manipulation (wheel, pinch, drag) moves a *target* that the live
//     value eases toward exponentially — instant response, cursor-anchored so
//     the time under the pointer stays pinned for the whole glide.
//   * Autonomous moves (magnetic detents, double-click, date jumps) run as
//     timed *flights* with a cubic ease-in-out — velocity-continuous, duration
//     scaled by distance, never a slam. Any user input cancels a flight.
//   * The magnetic detent is a *finisher*, not an autopilot: if input goes
//     idle mid-crossfade it completes the transition just past the band edge
//     (in the direction of travel) so the view rests resolved — it never flies
//     to a distant zoom level on its own. Distant levels are what double-click
//     is for.

const SPAN = ARCHIVE_END_MS - ARCHIVE_START_MS;
const PAD = SPAN * 0.04; // a little breathing room past the archive edges

// Easing time-constants (ms) for direct manipulation. Smaller = snappier.
const ZOOM_TAU = 95;
const PAN_TAU = 120;
const SCROLL_TAU = 120;
// Idle before a mid-transition zoom settles onto a resolved state ("lock in").
// Must sit above human wheel cadence (~200-400ms between notches) so it can't
// fire in the middle of a slow, deliberate scroll.
const IDLE_SNAP_MS = 420;
// Velocity decay for pan/scroll fling.
const FLING_TAU = 220;

// Flight timing: wind up, travel, land. Duration grows with distance so a
// short lock-in is quick and a cross-archive jump takes visibly longer.
const FLIGHT_MIN_MS = 180;
const FLIGHT_MS_PER_ZOOM_UNIT = 160;
const FLIGHT_MS_PER_PAN_SCREEN = 120;
const FLIGHT_MAX_MS = 640;

/** 1 - e^(-dt/tau): the fraction of the remaining gap to close this frame. */
const easeFactor = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

const easeInOutCubic = (s: number) => (s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2);

// Resolved zoom plateaus, in zoom-value units, where the view reads as one
// clean state. These are the *double-click* destinations — never detent
// destinations. Centres of the gaps between transition bands (see zoom.ts).
export const PLATEAU_ZOOMS = [
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

interface Flight {
  elapsed: number;
  dur: number;
  z0: number;
  z1: number;
  c0: number;
  c1: number;
  /** When set, keep `anchorTime` pinned under this screen x for the flight. */
  anchorX: number | null;
  anchorTime: number;
}

export class Camera {
  centerTimeMs: number;
  msPerPixel: number;
  scrollY = 0;
  viewportWidth = 1000;
  viewportHeight = 600;
  /** Height of the scrollable track content; set by the layout each frame. */
  contentHeight = 600;

  // Targets the live values ease toward (direct manipulation).
  private targetMsPerPixel: number;
  private targetCenterTimeMs: number;
  private targetScrollY = 0;

  // Cursor anchor for a glide-zoom: keep `anchorTime` pinned under `anchorX`.
  private anchorX: number | null = null;
  private anchorTime = 0;
  /** Screen x of the most recent zoom gesture — where detents settle around. */
  private lastZoomAnchorX: number | null = null;

  // Fling velocities (px per ms of input), decayed each frame after release.
  private velCenterMsPerMs = 0; // time-axis velocity, in archive-ms per ms
  private velScrollPxPerMs = 0;

  private idleMs = 0;
  private interacting = false;
  private snapEnabled = true;
  private lastZoomDir = 0; // +1 zooming in, -1 zooming out, 0 none

  private flight: Flight | null = null;

  /** Tightest zoom-in: everything resolves by z≈11.6; cap just past it so the
   *  whole wheel range maps onto meaning (no featureless magnification). */
  minMsPerPixel = mppForZoom(12.5);
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
    this.cancelFlight();
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
    this.cancelFlight();
    const dCenter = -dxPixels * this.msPerPixel;
    this.centerTimeMs += dCenter;
    this.targetCenterTimeMs = this.centerTimeMs;
    if (dtMs > 0) this.velCenterMsPerMs = dCenter / dtMs;
    this.anchorX = null;
    this.idleMs = 0;
    this.clampCenter();
  }

  scrollByPixels(dyPixels: number, dtMs = 16) {
    this.cancelFlight();
    this.scrollY += dyPixels;
    this.targetScrollY = this.scrollY;
    if (dtMs > 0) this.velScrollPxPerMs = dyPixels / dtMs;
    this.idleMs = 0;
    this.clampScroll();
  }

  /** Zoom toward a target scale while keeping the time under `anchorX` pinned. */
  zoomAt(anchorX: number, factor: number) {
    this.cancelFlight();
    this.anchorX = anchorX;
    this.lastZoomAnchorX = anchorX;
    this.anchorTime = this.xToTime(anchorX);
    this.targetMsPerPixel = clamp(this.targetMsPerPixel * factor, this.minMsPerPixel, this.maxMsPerPixel);
    if (factor < 1) this.lastZoomDir = 1; // fewer ms/px = zooming in
    else if (factor > 1) this.lastZoomDir = -1;
    this.idleMs = 0;
  }

  /** Double-click: fly to the next resolved plateau in the given direction,
   *  keeping the time under the click pinned. One continuous motion. */
  flyToPlateau(dir: 1 | -1, anchorX: number) {
    this.cancelFlight();
    const z = zoomValue(this.msPerPixel);
    const minZ = zoomValue(this.maxMsPerPixel);
    const maxZ = zoomValue(this.minMsPerPixel);
    // Skip plateaus closer than 0.3 so a click always travels somewhere.
    const dest =
      dir > 0
        ? PLATEAU_ZOOMS.find((p) => p > z + 0.3)
        : [...PLATEAU_ZOOMS].reverse().find((p) => p < z - 0.3);
    this.lastZoomDir = dir;
    this.startFlight(clamp(dest ?? (dir > 0 ? maxZ : minZ), minZ, maxZ), anchorX);
  }

  /** Animate the camera to frame a given time at a given scale (date jump). */
  flyTo(timeMs: number, msPerPixel: number) {
    this.cancelFlight();
    const mpp = clamp(msPerPixel, this.minMsPerPixel, this.maxMsPerPixel);
    this.startFlight(zoomValue(mpp), null, timeMs);
  }

  // ── per-frame integration ──────────────────────────────────────────────────
  update(dtMs: number) {
    const dt = clamp(dtMs, 1, 64); // guard against tab-switch frame spikes

    // A flight owns the zoom + horizontal pan while it runs.
    if (this.flight) {
      const f = this.flight;
      f.elapsed += dt;
      const s = easeInOutCubic(clamp(f.elapsed / f.dur, 0, 1));
      this.msPerPixel = mppForZoom(f.z0 + (f.z1 - f.z0) * s);
      if (f.anchorX !== null) {
        this.centerTimeMs = f.anchorTime - (f.anchorX - this.viewportWidth / 2) * this.msPerPixel;
      } else {
        this.centerTimeMs = f.c0 + (f.c1 - f.c0) * s;
      }
      this.clampCenter();
      this.targetMsPerPixel = this.msPerPixel;
      this.targetCenterTimeMs = this.centerTimeMs;
      if (f.elapsed >= f.dur) {
        this.flight = null;
        this.idleMs = 0;
      }
      this.scrollY += (this.targetScrollY - this.scrollY) * easeFactor(dt, SCROLL_TAU);
      this.clampScroll();
      return;
    }

    // Idle accounting drives the magnetic detent ("lock in"). It only fires
    // once the glide has settled — never while a zoom is still in motion.
    if (!this.interacting) this.idleMs += dt;
    const zoomSettled = Math.abs(this.targetMsPerPixel - this.msPerPixel) < this.msPerPixel * 0.02;
    if (!this.interacting && this.snapEnabled && zoomSettled && this.idleMs >= IDLE_SNAP_MS) {
      this.snapToDetent();
      if (this.flight) return; // flight starts next frame from current state
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
   * If the zoom came to rest mid-transition (a half-split, muddy state), finish
   * the crossfade just past the band edge — in the direction the user was
   * heading, or the nearer edge if there's no recorded direction. It never
   * travels further than the band it's in; distant levels are double-click's
   * job. If the zoom already rests on a resolved state, nothing moves.
   */
  private snapToDetent() {
    const z = zoomValue(this.msPerPixel);
    const band = TRANSITION_BANDS.find((b) => z > b[0] + 0.02 && z < b[1] - 0.02);
    if (!band) return; // already resting on a resolved state — leave it
    let destZ: number;
    if (this.lastZoomDir > 0) destZ = band[1] + 0.1;
    else if (this.lastZoomDir < 0) destZ = band[0] - 0.1;
    else destZ = z - band[0] < band[1] - z ? band[0] - 0.1 : band[1] + 0.1;
    // Settle around where the user was zooming (fall back to viewport centre).
    const anchorX = clamp(this.lastZoomAnchorX ?? this.viewportWidth / 2, 0, this.viewportWidth);
    this.startFlight(destZ, anchorX);
  }

  /** Begin a timed, distance-scaled camera flight (see Flight). */
  private startFlight(destZ: number, anchorX: number | null, destCenterMs?: number) {
    const minZ = zoomValue(this.maxMsPerPixel);
    const maxZ = zoomValue(this.minMsPerPixel);
    const z0 = zoomValue(this.msPerPixel);
    const z1 = clamp(destZ, minZ, maxZ);
    const c0 = this.centerTimeMs;
    const c1 = destCenterMs ?? c0;
    // Pan distance measured in screens at the coarser of the two scales.
    const mppCoarse = Math.max(this.msPerPixel, mppForZoom(z1));
    const panScreens = Math.abs(c1 - c0) / (mppCoarse * this.viewportWidth);
    const dur = clamp(
      FLIGHT_MIN_MS + FLIGHT_MS_PER_ZOOM_UNIT * Math.abs(z1 - z0) + FLIGHT_MS_PER_PAN_SCREEN * Math.min(panScreens, 3),
      FLIGHT_MIN_MS,
      FLIGHT_MAX_MS,
    );
    this.flight = {
      elapsed: 0,
      dur,
      z0,
      z1,
      c0,
      c1,
      anchorX,
      anchorTime: anchorX !== null ? this.xToTime(anchorX) : 0,
    };
    this.velCenterMsPerMs = 0;
    this.velScrollPxPerMs = 0;
    this.anchorX = null;
    this.idleMs = 0;
  }

  /** Abort any autonomous flight — user input always wins, mid-motion. */
  private cancelFlight() {
    if (!this.flight) return;
    this.flight = null;
    this.targetMsPerPixel = this.msPerPixel;
    this.targetCenterTimeMs = this.centerTimeMs;
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
}
