// The continuous semantic-zoom model. There are no discrete views — only a
// single continuous `zoom` value, with transition bands where new information
// gradually fades in. Never pop: always fade, split, slide, or resolve.

export const MS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  year: 365 * 86_400_000,
};

/** Reference scale so zoom ≈ 0 is fully zoomed out and grows as you zoom in. */
const BASE_MS_PER_PX = 5 * MS.year / 1000;

/** zoom = log2(BASE / msPerPixel). Larger = more detail. */
export function zoomValue(msPerPixel: number): number {
  return Math.log2(BASE_MS_PER_PX / msPerPixel);
}

/** Inverse of zoomValue: the msPerPixel that renders a given zoom value. */
export function mppForZoom(zoom: number): number {
  return BASE_MS_PER_PX / Math.pow(2, zoom);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

// Transition bands, in zoom-value units. Tuned by feel; calm and physical.
// The archive now spans a century, so the early splits happen at decade
// scale (viewport ≈ 30y → 13y → 2y) while the day-scale bands stay put.
//   archive ──split──> TV/Radio ──split──> channels ──resolve──> programmes
export const BANDS = {
  archiveToMedia: [-2.0, -0.8] as const, // whole archive → TV / Radio bands
  mediaToChannel: [-0.2, 1.8] as const, // TV / Radio → individual channel lanes
  aggregateToProgramme: [6.6, 8.6] as const, // density strata → programme bars
  labels: [8.8, 9.8] as const, // programme titles fade in when there's room
  metadata: [10.6, 11.6] as const, // richer per-programme detail
};

export interface ZoomState {
  zoom: number;
  /** 0 → archive only; 1 → TV/Radio fully present. */
  pMedia: number;
  /** 0 → media bands; 1 → channel lanes fully present. */
  pChannel: number;
  /** 0 → aggregate density; 1 → individual programme bars. */
  pProgramme: number;
  /** 0 → no labels; 1 → labels fully visible. */
  pLabels: number;
  pMetadata: number;
}

export function computeZoomState(msPerPixel: number): ZoomState {
  const zoom = zoomValue(msPerPixel);
  return {
    zoom,
    pMedia: smoothstep(BANDS.archiveToMedia[0], BANDS.archiveToMedia[1], zoom),
    pChannel: smoothstep(BANDS.mediaToChannel[0], BANDS.mediaToChannel[1], zoom),
    pProgramme: smoothstep(BANDS.aggregateToProgramme[0], BANDS.aggregateToProgramme[1], zoom),
    pLabels: smoothstep(BANDS.labels[0], BANDS.labels[1], zoom),
    pMetadata: smoothstep(BANDS.metadata[0], BANDS.metadata[1], zoom),
  };
}
